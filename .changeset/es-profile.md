---
"llm-output-guard": minor
---

`expectLang: 'es'` now separates Spanish from Portuguese, Italian and French.

It did not before. The profile held the twenty commonest Spanish function words
— `de`, `que`, `por`, `para`, `no`, `se`, `como` — and most of those are shared
with the other Romance languages. Since the score is `(best - target) / best`
across every profile, a shared word raises `target` as much as `best` and the
score collapses. A Portuguese answer scored **0.36** against `expectLang: 'es'`
and passed a check that existed to catch exactly that.

Rebuilt the way every other profile is: from where the languages differ rather
than from what is commonest. `y`/`e`, `es`/`é`/`è`, `no`/`não`/`non`,
`muy`/`muito`/`molto`, `pero`/`mas`/`ma`, `cuando`/`quando`, `donde`/`onde`/`dove`,
`sin`/`sem`/`senza`, `hasta`/`até`/`fino`.

Measured over two unrelated sample sets, a response in another language scored
against `'es'`:

```
       before          after
pt     0.36 / 0.50     0.91 / 0.75
it     0.83 / 0.33     1.00 / 1.00
fr     0.30 / 0.33     1.00 / 1.00
nl     0.69 / 0.73     1.00 / 1.00
```

Every one of those crossed the 0.6 default. Nothing else moved.

## Why this is a minor and not a major

Changing a threshold or a preset number is a major here, and swapping a word
list looks like the same kind of change. It is not, because the semver table
also covers "making an existing detector strictly more accurate on its own
axis" — and the measurements say that is what this is:

- **catches strictly more**: four languages cross the threshold that did not
- **false-positives no more**: Spanish still scores 0.000 against itself on both
  sample sets, as does every other language against itself
- **disturbs nothing else**: no other expectation's verdict changes, in either
  direction, on any pair

The only responses whose verdict changes are ones that were being missed. Nobody
can be relying on `expectLang: 'es'` passing a Portuguese answer.

The limitation was documented in the README, in `docs/detectors.md` and in
`src/detectors/language.ts`, and pinned by a test asserting the weakness. All
four now say the opposite, and the test asserts the fix.
