import { describe, it, expect } from 'vitest';
import { checkOutput } from '../src/index.js';
import { scriptMismatchScore, scriptProfile, supportedScripts } from '../src/detectors/index.js';
import { createStreamGuard } from '../src/stream.js';
import { presets } from '../src/presets.js';
import { goodFixtures } from './fixtures/load.js';

/**
 * Full answers in the wrong alphabet. Every one of these is what a model
 * actually does when it ignores "answer in English" -- it does not produce
 * broken English, it produces fluent something-else.
 */
const WRONG_LANGUAGE: Record<string, string> = {
  zh: '这个问题的答案取决于你的部署方式。如果你使用容器编排系统，那么健康检查应该配置在编排层面，而不是在应用内部。这样可以避免重复的逻辑，也更容易统一管理。',
  ru: 'Ответ на этот вопрос зависит от того, как вы разворачиваете приложение. Если вы используете оркестратор контейнеров, проверки состояния следует настраивать на уровне оркестратора.',
  ar: 'تعتمد الإجابة على هذا السؤال على طريقة نشر التطبيق. إذا كنت تستخدم نظام تنسيق الحاويات، فيجب تكوين فحوصات السلامة على مستوى المنسق وليس داخل التطبيق نفسه.',
  ja: 'この質問の答えは、アプリケーションをどのようにデプロイするかによって異なります。コンテナオーケストレーションを使用している場合、ヘルスチェックはオーケストレーター側で設定するべきです。',
  ko: '이 질문에 대한 답은 애플리케이션을 어떻게 배포하는지에 따라 달라집니다. 컨테이너 오케스트레이션을 사용한다면 헬스 체크는 오케스트레이터 수준에서 설정해야 합니다.',
  hi: 'इस प्रश्न का उत्तर इस बात पर निर्भर करता है कि आप एप्लिकेशन को कैसे तैनात करते हैं। यदि आप कंटेनर ऑर्केस्ट्रेशन का उपयोग कर रहे हैं तो हेल्थ चेक ऑर्केस्ट्रेटर स्तर पर होनी चाहिए।',
  el: 'Η απάντηση σε αυτή την ερώτηση εξαρτάται από τον τρόπο με τον οποίο αναπτύσσετε την εφαρμογή σας και από το αν χρησιμοποιείτε ενορχηστρωτή κοντέινερ.',
  he: 'התשובה לשאלה הזו תלויה באופן שבו אתה פורס את היישום שלך. אם אתה משתמש במערכת תזמור מכולות, בדיקות התקינות צריכות להיות מוגדרות ברמת המתזמר.',
  th: 'คำตอบของคำถามนี้ขึ้นอยู่กับวิธีการปรับใช้แอปพลิเคชันของคุณ หากคุณใช้ระบบจัดการคอนเทนเนอร์ การตรวจสอบสถานะควรตั้งค่าที่ระดับตัวจัดการ',
};

describe('scriptMismatchScore: catches the whole-answer case', () => {
  for (const [lang, text] of Object.entries(WRONG_LANGUAGE)) {
    it(`scores a full ${lang} answer at 1 against latin`, () => {
      expect(scriptMismatchScore(text, 'latin')).toBe(1);
    });
  }

  it('scores an English answer at 0 against latin', () => {
    const text =
      'The answer depends on how you deploy. If you are running a container orchestrator, ' +
      'health checks belong at the orchestrator level rather than inside the application.';
    expect(scriptMismatchScore(text, 'latin')).toBe(0);
  });

  /**
   * The line the whole detector rests on. It is not a language detector and
   * must not be mistaken for one: same script, no signal, no matter how
   * different the languages are.
   */
  it('is silent between languages that share a script', () => {
    const spanish =
      'La respuesta depende de cómo despliegues la aplicación. Si utilizas un orquestador ' +
      'de contenedores, las comprobaciones de estado deben configurarse en ese nivel.';
    expect(scriptMismatchScore(spanish, 'latin')).toBe(0);
  });
});

describe('scriptMismatchScore: what it refuses to judge', () => {
  it('abstains below the letter floor rather than guessing', () => {
    // Eleven Han letters, which is one short of the default minimum.
    expect(scriptMismatchScore('好的已经完成了这项任务', 'latin')).toBe(0);
    // Twelve is enough, and then it is certain.
    expect(scriptMismatchScore('好的已经完成了这项任务请', 'latin')).toBe(1);
  });

  it('abstains on text with no letters at all', () => {
    for (const empty of ['42', '{"n":1}', '   ', '...', '🚀🚀🚀']) {
      expect(scriptMismatchScore(empty, 'latin'), empty).toBe(0);
    }
  });

  it('abstains on an unknown script name instead of throwing', () => {
    expect(scriptMismatchScore(WRONG_LANGUAGE.zh, 'klingon' as never)).toBe(0);
    expect(scriptMismatchScore(WRONG_LANGUAGE.zh, [] as never)).toBe(0);
  });

  /**
   * The `requiredKeys` bug from 1.3.1, in a place it would have been worse: a
   * prototype name here would have been read as a regex and thrown from a
   * package that promises it never throws about a response.
   */
  it('does not read script names off Object.prototype', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(() => scriptMismatchScore(WRONG_LANGUAGE.zh, name as never)).not.toThrow();
      expect(scriptMismatchScore(WRONG_LANGUAGE.zh, name as never), name).toBe(0);
    }
  });

  /**
   * Precomposed and decomposed accents must measure the same. Combining marks
   * are `Script=Inherited`, so counting them as letters would make every
   * accented Latin response partly "not Latin".
   */
  it('treats combining marks as script-neutral', () => {
    const precomposed = 'café naïve résumé coordonné équipe préférée données validées';
    const decomposed = precomposed.normalize('NFD');
    expect(decomposed.length).toBeGreaterThan(precomposed.length);
    expect(scriptMismatchScore(precomposed, 'latin')).toBe(0);
    expect(scriptMismatchScore(decomposed, 'latin')).toBe(0);
  });
});

describe('scriptMismatchScore: code is not an answer', () => {
  const chineseWithCode =
    '你可以这样配置重试逻辑，请看下面的示例代码：\n\n```ts\n' +
    'const client = new OpenAI({ maxRetries: 3, timeout: 30_000 });\n' +
    'async function callWithFallback(prompt: string) {\n' +
    '  return client.chat.completions.create({ model: "gpt-4", messages: [] });\n' +
    '}\n```\n\n更多细节请参考 https://platform.openai.com/docs/guides/error-handling 这个页面。';

  it('does not count a fenced code block against a non-Latin answer', () => {
    expect(scriptMismatchScore(chineseWithCode, 'han')).toBe(0);
  });

  it('is exactly the false positive ignoreCode:false reproduces', () => {
    expect(scriptMismatchScore(chineseWithCode, 'han', { ignoreCode: false }))
      .toBeGreaterThan(0.8);
  });

  it('strips an unclosed fence to the end, which is what a truncated response has', () => {
    const truncated = '好的，下面是完整的实现代码，请注意错误处理部分：\n\n```ts\nconst client = new OpenAI();\nasync function main() {';
    expect(scriptMismatchScore(truncated, 'han')).toBe(0);
  });

  it('ignores inline code and URLs', () => {
    const text =
      '请使用 `maxRetries` 选项来配置重试次数，默认值是两次。完整说明见 ' +
      'https://platform.openai.com/docs/api-reference/introduction 这一节。';
    expect(scriptMismatchScore(text, 'han')).toBe(0);
  });

  /**
   * A response that is nothing but code has no opinion about language, and the
   * honest answer is silence rather than a mismatch against whatever the
   * identifiers happen to be written in.
   */
  it('abstains on a response that is only a code block', () => {
    const onlyCode = '```python\ndef retry(fn, attempts=3):\n    for i in range(attempts):\n        try:\n            return fn()\n        except Exception:\n            continue\n```';
    expect(scriptMismatchScore(onlyCode, 'han')).toBe(0);
    expect(scriptMismatchScore(onlyCode, 'latin')).toBe(0);
  });
});

describe('scriptMismatchScore: multi-script expectations', () => {
  it('needs both han and kana for Japanese', () => {
    const ja = WRONG_LANGUAGE.ja;
    expect(scriptMismatchScore(ja, 'kana')).toBeGreaterThan(0.1);
    expect(scriptMismatchScore(ja, ['han', 'kana'])).toBe(0);
  });

  it('tolerates borrowed technical terms once latin is included', () => {
    const ko = goodFixtures.find((f) => f.id === 'prose-ko-technical')!.text;
    expect(scriptMismatchScore(ko, 'hangul')).toBeLessThan(0.05);
    expect(scriptMismatchScore(ko, ['hangul', 'latin'])).toBe(0);
  });
});

describe('scriptProfile', () => {
  it('reports shares that sum to 1', () => {
    const profile = scriptProfile(WRONG_LANGUAGE.ja);
    const total = Object.values(profile).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(profile.kana).toBeGreaterThan(0.5);
    expect(profile.han).toBeGreaterThan(0);
    expect(profile.latin).toBe(0);
  });

  it('returns nothing for text it cannot judge', () => {
    expect(scriptProfile('42 !!')).toEqual({});
  });

  it('names every script the detector accepts', () => {
    expect(supportedScripts).toContain('latin');
    expect(supportedScripts).toContain('han');
    expect(supportedScripts.length).toBe(10);
  });
});

/**
 * The margin that justifies the default threshold.
 *
 * A wrong-language answer scores 1.000. The worst *healthy* case anyone has
 * constructed -- an English answer that ends by quoting a long Chinese passage
 * -- scores 0.244. The default sits between them with room on both sides, and
 * this test fails if either edge moves toward it.
 */
describe('the 0.5 default has margin on both sides', () => {
  const englishQuotingChinese =
    'The migration guide is explicit about this, and the passage is worth quoting in full ' +
    'because teams keep reading past it. It says the connection pool is not shared across ' +
    'workers, which is the detail that makes the retry budget per-worker rather than global. ' +
    'Here is the original text:\n\n' +
    '连接池不会在工作进程之间共享。每个工作进程都会维护自己的连接池，因此重试预算也是按工作进程计算的，而不是全局计算的。' +
    '如果你在部署时增加了工作进程的数量，那么数据库看到的并发连接总数也会随之增加。请务必相应地调整数据库的最大连接数配置。\n\n' +
    'So multiply your per-worker pool size by the worker count before comparing to the limit.';

  it('a healthy mixed-script answer stays well under it', () => {
    const score = scriptMismatchScore(englishQuotingChinese, 'latin');
    expect(score).toBeLessThan(0.3);
    expect(checkOutput(englishQuotingChinese, { ...presets.chat, expectScript: 'latin' }).ok)
      .toBe(true);
  });

  /**
   * Every healthy single-script fixture in the corpus, measured against the
   * script it is actually written in. Anything above zero here is a response
   * this package would have thrown away for containing its own alphabet.
   */
  it('every healthy fixture scores 0 against the scripts it is written in', () => {
    const expectations: Record<string, Parameters<typeof scriptMismatchScore>[1]> = {
      'prose-zh-technical': ['han', 'latin'],
      'prose-zh-numbered-list': ['han', 'latin'],
      'prose-zh-poem-refrain': ['han', 'latin'],
      'prose-zh-repeated-prefix-steps': ['han', 'latin'],
      'prose-ja-identical-clause': ['han', 'kana', 'latin'],
      'prose-ko-technical': ['hangul', 'latin'],
      'prose-th-repeated-prefix': ['thai', 'latin'],
      'json-zh-keys-valid': ['han', 'latin'],
      'json-zh-array-valid': ['han', 'latin'],
    };

    const offenders = goodFixtures
      // Fixtures that declare `expectScript` are the mixed-script traps, and
      // they are held to the threshold rather than to zero, just below.
      .filter((fx) => !fx.options?.expectScript)
      .map((fx) => ({ id: fx.id, score: scriptMismatchScore(fx.text, expectations[fx.id] ?? 'latin') }))
      .filter((x) => x.score > 0);

    expect(offenders, 'healthy fixtures flagged against their own script').toEqual([]);
  });

  /**
   * The traps: a Chinese answer carrying a TypeScript block, and an English
   * answer quoting a Chinese passage. Both are legitimately mixed, and both
   * must sit in the lower half of the margin -- the same bound the corpus
   * applies to every other detector's healthy fixtures.
   */
  it('the deliberately mixed fixtures stay in the lower half of the margin', () => {
    const mixed = goodFixtures.filter((fx) => fx.options?.expectScript);
    expect(mixed.length, 'the corpus carries mixed-script traps at all')
      .toBeGreaterThanOrEqual(2);

    for (const fx of mixed) {
      const expected = fx.options!.expectScript as Parameters<typeof scriptMismatchScore>[1];
      expect(scriptMismatchScore(fx.text, expected), fx.id).toBeLessThan(0.25);
    }
  });
});

describe('SCRIPT_MISMATCH in a verdict', () => {
  it('fails the check and reports its own code and score', () => {
    const verdict = checkOutput(WRONG_LANGUAGE.zh, { ...presets.chat, expectScript: 'latin' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('SCRIPT_MISMATCH');
    expect(verdict.scores.SCRIPT_MISMATCH).toBe(1);
  });

  it('is off unless asked for', () => {
    const verdict = checkOutput(WRONG_LANGUAGE.zh, presets.chat);
    expect(verdict.ok).toBe(true);
    expect(verdict.scores.SCRIPT_MISMATCH).toBeUndefined();
  });

  it('is not present in any preset', () => {
    for (const [name, preset] of Object.entries(presets)) {
      expect((preset as { expectScript?: unknown }).expectScript, name).toBeUndefined();
    }
  });

  /**
   * Both may be enabled. They must not collapse into one another: a Spanish
   * answer to an English prompt is a language mismatch and not a script one,
   * and each has to be readable on its own in `scores`.
   */
  it('reports separately from LANG_MISMATCH', () => {
    const spanish =
      'La respuesta depende de cómo despliegues la aplicación en producción. Si utilizas un ' +
      'orquestador de contenedores, las comprobaciones de estado deben configurarse en ese ' +
      'nivel y no dentro de la aplicación, porque así se evita duplicar la misma lógica.';
    const verdict = checkOutput(spanish, {
      ...presets.chat,
      expectScript: 'latin',
      expectLang: 'en',
    });
    expect(verdict.scores.SCRIPT_MISMATCH).toBe(0);
    expect(verdict.scores.LANG_MISMATCH).toBeGreaterThan(0.6);
    expect(verdict.reasons.map((r) => r.code)).toEqual(['LANG_MISMATCH']);
  });

  it('honours a custom threshold', () => {
    const mixed =
      'Here is the summary you asked for. ' +
      '以下是完整的中文说明，请仔细阅读后再继续操作，谢谢配合，如有疑问请联系我们。';
    const score = scriptMismatchScore(mixed, 'latin');
    expect(score).toBeGreaterThan(0.5);
    expect(checkOutput(mixed, { expectScript: 'latin', maxScriptMismatch: score + 0.01 }).ok)
      .toBe(true);
    expect(checkOutput(mixed, { expectScript: 'latin', maxScriptMismatch: score - 0.01 }).ok)
      .toBe(false);
  });
});

/**
 * Deferred deliberately, and the deferral is load-bearing -- see the comment in
 * `stream.ts`. A mid-stream check reads a trailing window, and the language of
 * a window is not the language of the response.
 */
describe('streaming defers the script check to the end', () => {
  const wrongLanguageStream = WRONG_LANGUAGE.zh + WRONG_LANGUAGE.zh;

  it('never reports SCRIPT_MISMATCH mid-stream', () => {
    const guard = createStreamGuard({ ...presets.chat, expectScript: 'latin', warmup: 60 });
    const verdicts = [];
    for (let i = 0; i < wrongLanguageStream.length; i += 40) {
      const v = guard.push(wrongLanguageStream.slice(i, i + 40));
      if (v) verdicts.push(v);
    }
    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) expect(v.scores.SCRIPT_MISMATCH).toBeUndefined();
  });

  it('reports it at end(), where the whole response is in scope', () => {
    const guard = createStreamGuard({ ...presets.chat, expectScript: 'latin', warmup: 60 });
    guard.push(wrongLanguageStream);
    const final = guard.end();
    expect(final.ok).toBe(false);
    expect(final.reasons.map((r) => r.code)).toContain('SCRIPT_MISMATCH');
  });

  it('the documented one-liner still gets you the early signal', () => {
    const guard = createStreamGuard({ ...presets.chat, warmup: 60 });
    guard.push(WRONG_LANGUAGE.zh.slice(0, 80));
    expect(checkOutput(guard.text, { expectScript: 'latin' }).ok).toBe(false);
  });
});
