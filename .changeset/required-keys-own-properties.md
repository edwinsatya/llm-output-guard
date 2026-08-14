---
'llm-output-guard': patch
---

`requiredKeys` no longer accepts a name inherited from `Object.prototype`.

The check was `k in record`, which walks the prototype chain — so seven names
were reported as present on a payload that never contained them:

```ts
jsonScore('{"score":8}', { requiredKeys: ['constructor'] }); // score 0, "present"
```

`toString`, `valueOf`, `constructor`, `hasOwnProperty`, `isPrototypeOf`,
`propertyIsEnumerable` and `toLocaleString` all passed. `constructor` is the one
plausible in a real contract — a payload describing a builder or a class — and it
silently disabled that key's check.

Now `Object.hasOwn`. The contract is "keys the payload must contain", and an
inherited name is not one the model wrote. A payload that genuinely declares
`"constructor"` still satisfies it.

No other behaviour changes: verified byte-identical to the published 1.2.1 across
all 228 fixture × preset combinations.
