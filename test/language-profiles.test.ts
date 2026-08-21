import { describe, it, expect } from 'vitest';
import { languageMismatchScore, languageProfile, supportedLanguages } from '../src/detectors/index.js';
import { checkOutput } from '../src/index.js';
import { presets } from '../src/presets.js';

/**
 * `expectLang` covers eight languages, and the interesting part is what happens
 * between the ones that share an alphabet.
 *
 * The score is `(best - target) / best` across every profile, so adding a
 * language changes the denominator for the ones already there. A profile built
 * from a language's *commonest* words is therefore the wrong profile: those are
 * the words its neighbours share, and a shared word raises `target` as much as
 * `best`. The newer profiles are built from the words where neighbouring
 * languages differ instead.
 */

/** One paragraph of ordinary technical prose per language. */
const A: Record<string, string> = {
  en: 'The connection pool is created once per worker process and is never shared across them. That single fact drives most of the confusion teams have with the retry budget, because the budget is expressed per pool rather than per service. When you scale the workers you scale the pools as well.',
  es: 'El grupo de conexiones se crea una vez por proceso de trabajo y no se comparte entre ellos. Ese hecho explica la mayor parte de la confusión que tienen los equipos con el presupuesto de reintentos, porque el presupuesto se expresa por grupo y no por servicio.',
  id: 'Kumpulan koneksi dibuat sekali untuk setiap proses pekerja dan tidak pernah dibagikan di antara mereka. Fakta itu adalah penyebab utama kebingungan yang dialami tim dengan anggaran percobaan ulang, karena anggaran itu dihitung per kumpulan dan bukan per layanan.',
  pt: 'O conjunto de conexões é criado uma vez por processo de trabalho e não é compartilhado entre eles. Esse fato explica a maior parte da confusão que as equipes têm com o orçamento de novas tentativas, porque o orçamento é expresso por conjunto e não por serviço. Você também precisa considerar isso.',
  it: 'Il pool di connessioni viene creato una volta per ogni processo di lavoro e non è mai condiviso tra di essi. Questo fatto spiega gran parte della confusione che i team hanno con il budget dei tentativi, perché il budget è espresso per pool e non per servizio. Anche gli sviluppatori lo dimenticano.',
  fr: 'Le pool de connexions est créé une fois par processus de travail et il n est jamais partagé entre eux. Ce fait explique la plus grande partie de la confusion que les équipes ont avec le budget de tentatives, car ce budget est exprimé par pool et non par service. Vous devez donc ajuster ces valeurs dans chaque déploiement.',
  de: 'Der Verbindungspool wird einmal pro Arbeitsprozess erstellt und niemals zwischen ihnen geteilt. Diese Tatsache erklärt den größten Teil der Verwirrung, die Teams mit dem Wiederholungsbudget haben, denn das Budget wird pro Pool und nicht pro Dienst ausgedrückt. Man kann das auch messen.',
  nl: 'De verbindingspool wordt eenmaal per werkproces gemaakt en wordt nooit tussen processen gedeeld. Dat feit verklaart het grootste deel van de verwarring die teams hebben met het herhalingsbudget, omdat het budget per pool wordt uitgedrukt en niet per dienst. Dit moet je ook meten.',
};

/** A second, unrelated paragraph, so no result rests on one sample. */
const B: Record<string, string> = {
  en: 'You should alert on rejected connections rather than on average pool utilisation, because the average will look healthy while the tail is failing. During a rolling deploy the process count briefly doubles, so the peak you must survive is twice the steady state.',
  es: 'Debes alertar sobre las conexiones rechazadas y no sobre la utilización media del grupo, porque la media parecerá saludable mientras la cola falla. Durante un despliegue gradual el número de procesos se duplica brevemente.',
  id: 'Anda harus memberi peringatan pada koneksi yang ditolak dan bukan pada rata rata penggunaan kumpulan, karena rata rata akan terlihat sehat sementara ekornya gagal. Selama penerapan bertahap jumlah proses akan berlipat ganda.',
  pt: 'Você deve alertar sobre as conexões rejeitadas e não sobre a utilização média do conjunto, porque a média parecerá saudável enquanto a cauda está falhando. Durante uma implantação gradual o número de processos dobra brevemente, então planeje para o pico.',
  it: 'Dovresti avvisare sulle connessioni rifiutate e non sull utilizzo medio del pool, perché la media sembrerà sana mentre la coda sta fallendo. Durante un rilascio graduale il numero dei processi raddoppia brevemente, quindi il picco è più alto.',
  fr: 'Vous devez alerter sur les connexions rejetées et non sur le taux moyen du pool, car la moyenne paraîtra saine pendant que la queue échoue. Pendant un déploiement progressif le nombre de processus double brièvement, donc ce pic est plus haut que tout.',
  de: 'Sie sollten auf abgelehnte Verbindungen achten und nicht auf die durchschnittliche Auslastung, denn der Durchschnitt wird gesund aussehen, während das Ende ausfällt. Bei einem schrittweisen Rollout wird die Anzahl der Prozesse kurz verdoppelt.',
  nl: 'Je moet waarschuwen bij geweigerde verbindingen en niet bij het gemiddelde gebruik, omdat het gemiddelde er gezond uitziet terwijl de staart faalt. Tijdens een geleidelijke uitrol wordt het aantal processen kort verdubbeld door de nieuwe versie.',
};

const LANGS = Object.keys(A);
const SAMPLES = [A, B];

describe('the profiles that were there before still behave', () => {
  it('recognises every language it claims to', () => {
    expect(supportedLanguages).toEqual(['id', 'en', 'es', 'pt', 'it', 'fr', 'de', 'nl']);
  });

  /**
   * The regression this widening could have caused. Adding a profile adds a
   * candidate for `best`, so a new language that out-scored `en` on English
   * text would start failing healthy English responses.
   */
  it('does not make id, en or es fail on their own text', () => {
    for (const sample of SAMPLES) {
      for (const lang of ['id', 'en', 'es']) {
        expect(languageMismatchScore(sample[lang], lang), `${lang}`).toBe(0);
      }
    }
  });
});

describe('every language scores zero against itself', () => {
  for (const lang of LANGS) {
    it(`${lang}`, () => {
      for (const sample of SAMPLES) {
        expect(languageMismatchScore(sample[lang], lang)).toBe(0);
      }
    });
  }
});

describe('the languages that are actually separable', () => {
  /**
   * Every pair, `es` included. Until 1.7.0 that expectation had to be exempted
   * here, because its profile was the twenty commonest Spanish function words
   * and most of them are shared with Portuguese, Italian or French.
   */
  it('scores every cross-language pair above the 0.6 default', () => {
    const weak: string[] = [];
    for (const sample of SAMPLES) {
      for (const text of LANGS) {
        for (const expected of LANGS) {
          if (text === expected) continue;
          const score = languageMismatchScore(sample[text], expected);
          if (score <= 0.6) weak.push(`${text} as ${expected} = ${score.toFixed(2)}`);
        }
      }
    }
    expect(weak, 'pairs that would not be caught at the default threshold').toEqual([]);
  });

  it('catches a German answer where English was asked for', () => {
    const verdict = checkOutput(A.de, { ...presets.chat, expectLang: 'en' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.map((r) => r.code)).toContain('LANG_MISMATCH');
  });

  it('catches Portuguese where Indonesian was asked for', () => {
    expect(languageMismatchScore(A.pt, 'id')).toBeGreaterThan(0.6);
  });
});

/**
 * The weakness that used to live here, now the other way round.
 *
 * `es` originally held the commonest Spanish function words -- `de`, `que`,
 * `por`, `para`, `no`, `se`, `como` -- which Portuguese, Italian and French
 * share. Those raised `target` as much as `best`, so the score collapsed and a
 * Portuguese answer passed as Spanish at 0.36.
 */
describe('expectLang: es separates Spanish from its neighbours', () => {
  it('catches the other Romance languages, which it used to miss', () => {
    for (const sample of SAMPLES) {
      for (const lang of ['pt', 'it', 'fr']) {
        const score = languageMismatchScore(sample[lang], 'es');
        expect(score, `${lang} answered where Spanish was asked for`).toBeGreaterThan(0.6);
      }
    }
  });

  it('and still says nothing about Spanish itself', () => {
    for (const sample of SAMPLES) {
      expect(languageMismatchScore(sample.es, 'es')).toBe(0);
    }
  });

  it('still catches the languages that were never the problem', () => {
    for (const sample of SAMPLES) {
      for (const lang of ['en', 'id', 'de', 'nl']) {
        expect(languageMismatchScore(sample[lang], 'es'), lang).toBeGreaterThan(0.6);
      }
    }
  });

  /**
   * What made replacing the profile a minor rather than a major: it catches
   * strictly more, false-positives no more, and moves no other expectation's
   * verdict.
   */
  it('leaves every other expectation undisturbed', () => {
    for (const sample of SAMPLES) {
      for (const lang of LANGS) {
        expect(languageMismatchScore(sample[lang], lang), `${lang} vs itself`).toBe(0);
      }
    }
  });
});

describe('the abstentions are unchanged', () => {
  it('says nothing about a language it does not know', () => {
    expect(languageMismatchScore(A.en, 'sv')).toBe(0);
    expect(languageMismatchScore(A.en, 'zh')).toBe(0);
  });

  it('still refuses a prototype name', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(languageMismatchScore(A.en, name), name).toBe(0);
    }
  });

  it('abstains under 25 words', () => {
    expect(languageMismatchScore('Der Verbindungspool wird einmal erstellt.', 'en')).toBe(0);
  });

  it('reports a share for every known language', () => {
    const profile = languageProfile(A.de);
    expect(Object.keys(profile).sort()).toEqual([...supportedLanguages].sort());
    expect(profile.de).toBeGreaterThan(profile.en);
  });
});
