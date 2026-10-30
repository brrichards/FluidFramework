---
"@fluidframework/tree": minor
"fluid-framework": minor
"__section": tree
---
Add a key encoding option to export only unknown optional fields

The new `KeyEncodingOptions.unknownStoredKeys` option makes `TreeAlpha.exportVerbose` and `TreeBeta.exportConcise` export only the content of [unknown optional fields](https://fluidframework.com/docs/api/fluid-framework/objectschemaoptions-interface#allowunknownoptionalfields-propertysignature).
Fields use their stored keys.

This applies to each node:

- A node of a type that is in the view schema keeps only its unknown optional fields.
- A node of a type that is not in the view schema keeps all of its fields.

You can use this option only for export.

```typescript
// The view schema of `Person` has only `name`.
// A newer version of the application added a `nickname` field.
TreeAlpha.exportVerbose(person, { keys: KeyEncodingOptions.unknownStoredKeys });
// { type: "com.example.Person", fields: { nickname: "Ali" } }
```
