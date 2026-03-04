/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert, fail } from "node:assert";

import { deepFreeze } from "@fluidframework/test-runtime-utils/internal";

import { currentVersion, type CodecWriteOptions } from "../../codec/index.js";
import {
	type DeltaDetachedNodeId,
	type TreeNodeSchemaIdentifier,
	type TreeStoredSchema,
	makeAnonChange,
	revisionMetadataSourceFromInfo,
	rootFieldKey,
	tagChange,
} from "../../core/index.js";
// eslint-disable-next-line import-x/no-internal-modules
import { forbidden } from "../../feature-libraries/default-schema/defaultFieldKinds.js";
import {
	DefaultEditBuilder,
	FieldKinds,
	ModularChangeFamily,
	type ModularChangeset,
	type TreeChunk,
	fieldKinds,
	type SchemaChange,
	intoDelta,
	DefaultRevisionReplacer,
	type FieldBatchCodec,
	FieldBatchFormatVersion,
	allowsRepoSuperset,
	defaultSchemaPolicy,
} from "../../feature-libraries/index.js";
import {
	SharedTreeChangeFamily,
	updateRefreshers,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../shared-tree/sharedTreeChangeFamily.js";
import type {
	SharedTreeChange,
	SharedTreeInnerChange,
	// eslint-disable-next-line import-x/no-internal-modules
} from "../../shared-tree/sharedTreeChangeTypes.js";
import { ajvValidator } from "../codec/index.js";
import {
	chunkFromJsonTrees,
	failCodecFamily,
	mintRevisionTag,
	testRevisionTagCodec,
} from "../utils.js";

const dataChanges: ModularChangeset[] = [];
const codecOptions: CodecWriteOptions = {
	jsonValidator: ajvValidator,
	minVersionForCollab: currentVersion,
};
const fieldBatchCodec: FieldBatchCodec = {
	encode: () => assert.fail("Unexpected encode"),
	decode: () => assert.fail("Unexpected decode"),
	writeVersion: FieldBatchFormatVersion.v2,
};

const modularFamily = new ModularChangeFamily(fieldKinds, failCodecFamily, codecOptions);
const defaultEditor = new DefaultEditBuilder(
	modularFamily,
	mintRevisionTag,
	(taggedChange) => dataChanges.push(taggedChange.change),
	codecOptions,
);

const rootField = { parent: undefined, field: rootFieldKey };
// Side effects results in `dataChanges` being populated
// The enter/exit transaction calls are used to ensure the first two change use the same local IDs in their change atoms.
// Specifically, `exitTransaction` resets the local ID space.
defaultEditor.enterTransaction();
defaultEditor.valueField(rootField).set(chunkFromJsonTrees(["X"]));
defaultEditor.exitTransaction();
defaultEditor.valueField(rootField).set(chunkFromJsonTrees(["Y"]));
defaultEditor.sequenceField(rootField).remove(0, 1);
defaultEditor.move(rootField, 0, 1, rootField, 0);

const dataChange1 = dataChanges[0];
const dataChange2 = dataChanges[1];
const dataChange3 = dataChanges[2];
const dataChange4 = dataChanges[3];
// This rebased change now refers to an ID introduced in dataChange3
const rebasedDataChange4 = modularFamily.rebaser.rebase(
	makeAnonChange(dataChange4),
	makeAnonChange(dataChange3),
	revisionMetadataSourceFromInfo([]),
);

const stDataChange1: SharedTreeChange = {
	changes: [{ type: "data", innerChange: dataChange1 }],
};
const stDataChange2: SharedTreeChange = {
	changes: [{ type: "data", innerChange: dataChange2 }],
};
const emptySchema: TreeStoredSchema = {
	nodeSchema: new Map(),
	rootFieldSchema: {
		kind: forbidden.identifier,
		types: new Set(),
		persistedMetadata: undefined,
	},
};
const innerSchemaChange = { schema: { new: emptySchema, old: emptySchema }, isInverse: false };
const stSchemaChange: SharedTreeChange = {
	changes: [{ type: "schema", innerChange: innerSchemaChange }],
};
const stEmptyChange: SharedTreeChange = {
	changes: [],
};

const sharedTreeFamily = new SharedTreeChangeFamily(
	testRevisionTagCodec,
	fieldBatchCodec,
	codecOptions,
);

describe("SharedTreeChangeFamily", () => {
	it("composition composes runs of data changes", () => {
		assert.deepEqual(
			sharedTreeFamily.compose([
				makeAnonChange(stDataChange1),
				makeAnonChange(stDataChange2),
				makeAnonChange(stSchemaChange),
				makeAnonChange(stDataChange1),
				makeAnonChange(stDataChange2),
				makeAnonChange(stDataChange2),
			]),
			{
				changes: [
					{
						type: "data",
						innerChange: modularFamily.compose([
							makeAnonChange(dataChange1),
							makeAnonChange(dataChange2),
						]),
					},
					stSchemaChange.changes[0],
					{
						type: "data",
						innerChange: modularFamily.compose([
							makeAnonChange(dataChange1),
							makeAnonChange(dataChange2),
							makeAnonChange(dataChange2),
						]),
					},
				],
			},
		);
	});

	it("empty changes result in no-op rebases", () => {
		assert.deepEqual(
			sharedTreeFamily.rebase(
				makeAnonChange(stSchemaChange),
				makeAnonChange(stEmptyChange),
				revisionMetadataSourceFromInfo([]),
			),
			stSchemaChange,
		);

		assert.deepEqual(
			sharedTreeFamily.rebase(
				makeAnonChange(stDataChange1),
				makeAnonChange(stEmptyChange),
				revisionMetadataSourceFromInfo([]),
			),
			stDataChange1,
		);
	});

	it("schema edits cause all concurrent changes to conflict", () => {
		assert.deepEqual(
			sharedTreeFamily.rebase(
				makeAnonChange(stSchemaChange),
				makeAnonChange(stDataChange1),
				revisionMetadataSourceFromInfo([]),
			),
			{
				changes: [],
			},
		);

		assert.deepEqual(
			sharedTreeFamily.rebase(
				makeAnonChange(stDataChange1),
				makeAnonChange(stSchemaChange),
				revisionMetadataSourceFromInfo([]),
			),
			{
				changes: [],
			},
		);

		assert.deepEqual(
			sharedTreeFamily.rebase(
				makeAnonChange(stSchemaChange),
				makeAnonChange(stSchemaChange),
				revisionMetadataSourceFromInfo([]),
			),
			{
				changes: [],
			},
		);
	});

	describe("without schema edits should behave identically to ModularChangeFamily", () => {
		it("when composing", () => {
			assert.deepEqual(
				sharedTreeFamily.compose([
					makeAnonChange(stDataChange1),
					makeAnonChange(stDataChange2),
				]),
				{
					changes: [
						{
							type: "data",
							innerChange: modularFamily.compose([
								makeAnonChange(dataChange1),
								makeAnonChange(dataChange2),
							]),
						},
					],
				},
			);
		});

		it("when rebasing", () => {
			assert.deepEqual(
				sharedTreeFamily.rebase(
					makeAnonChange(stDataChange1),
					makeAnonChange(stDataChange2),
					revisionMetadataSourceFromInfo([]),
				),
				{
					changes: [
						{
							type: "data",
							innerChange: modularFamily.rebase(
								makeAnonChange(dataChange1),
								makeAnonChange(dataChange2),
								revisionMetadataSourceFromInfo([]),
							),
						},
					],
				},
			);
		});

		for (const isRollback of [true, false]) {
			it(`when inverting (isRollback = ${isRollback})`, () => {
				const tag = mintRevisionTag();
				const inverted = sharedTreeFamily.invert(
					makeAnonChange(stDataChange1),
					isRollback,
					tag,
				);

				const expected = {
					changes: [
						{
							type: "data",
							innerChange: modularFamily.invert(makeAnonChange(dataChange1), isRollback, tag),
						},
					],
				};

				assert.deepEqual(inverted, expected);
			});
		}
	});

	describe("updateRefreshers", () => {
		// The tests below heavily mock the inputs to updateRefreshers.
		// This is done to simplify the tests, but it also has the effect of reducing their dependency on the
		// ModularChangeset format and on the behavior of the helper functions that operate on it.
		interface MockChange {
			/** The IDs of the nodes that are relevant to this change. This is the test input. */
			readonly relevant?: DeltaDetachedNodeId[];
			/** The refreshers associated with this change. This is the test output. */
			readonly refreshers?: string[];
		}

		const idInForest1: DeltaDetachedNodeId = { minor: 1 };
		const idInForest2: DeltaDetachedNodeId = { minor: 2 };
		const idNotInForest: DeltaDetachedNodeId = { minor: 3 };
		const refresher1: TreeChunk = "refresher1" as unknown as TreeChunk;
		const refresher2: TreeChunk = "refresher2" as unknown as TreeChunk;
		const schemaChange: SharedTreeInnerChange = {
			type: "schema",
			innerChange: "MockSchemaChange" as unknown as SchemaChange,
		};

		function updateDataChangeRefreshers(
			change: ModularChangeset,
			getDetachedNode: (id: DeltaDetachedNodeId) => TreeChunk | undefined,
			removedRoots: Iterable<DeltaDetachedNodeId>,
			requireRefreshers: boolean,
		): ModularChangeset {
			const mockChange = change as unknown as MockChange;
			const relevantToChange = new Set<DeltaDetachedNodeId>(mockChange.relevant ?? []);
			const refreshers: string[] = [];
			for (const id of removedRoots) {
				// Check that the removed root is indeed relevant to the change
				assert.equal(relevantToChange.has(id), true);
				const tree = getDetachedNode(id);
				if (tree === undefined) {
					if (requireRefreshers) {
						throw new Error("Missing tree");
					}
				} else {
					refreshers.push(tree as unknown as string);
				}
			}
			const updated: MockChange = {
				...mockChange,
				refreshers,
			};
			return updated as unknown as ModularChangeset;
		}
		function testUpdateRefreshers(mocks: readonly MockChange[]): string[][] {
			const input: SharedTreeChange = sharedTreeChangeFromMocks(mocks);
			deepFreeze(input);
			const updated = updateRefreshers(
				input,
				// Mock for getDetachedNode
				(id): TreeChunk | undefined => {
					switch (id) {
						case idInForest1: {
							return refresher1;
						}
						case idInForest2: {
							return refresher2;
						}
						default: {
							return undefined;
						}
					}
				},
				// Mock for relevantRemovedRootsFromDataChange
				(change: ModularChangeset): DeltaDetachedNodeId[] =>
					(change as unknown as MockChange).relevant ?? [],
				updateDataChangeRefreshers,
			);
			return refreshersFromSharedTreeChange(updated);
		}
		function sharedTreeChangeFromMocks(mocks: readonly MockChange[]): SharedTreeChange {
			const changes: SharedTreeInnerChange[] = [];
			for (const mock of mocks) {
				changes.push({
					type: "data",
					innerChange: mock as unknown as ModularChangeset,
				});
				changes.push(schemaChange);
			}
			return { changes };
		}
		function refreshersFromSharedTreeChange(change: SharedTreeChange): string[][] {
			const result: string[][] = [];
			for (const innerChange of change.changes) {
				if (innerChange.type === "data") {
					const mockChange = innerChange.innerChange as unknown as MockChange;
					result.push(mockChange.refreshers ?? []);
				}
			}
			return result;
		}

		it("updates all data changes", () => {
			const input: MockChange[] = [{ relevant: [idInForest1] }, { relevant: [idInForest2] }];
			const updated = testUpdateRefreshers(input);
			assert.deepEqual(updated, [[refresher1], [refresher2]]);
		});
		it("excludes refreshers from later changes if they are included in earlier changes", () => {
			const input: MockChange[] = [
				{ relevant: [idInForest1] },
				{ relevant: [idInForest1, idInForest2] },
				{ relevant: [idInForest1, idInForest2] },
			];
			const updated = testUpdateRefreshers(input);
			assert.deepEqual(updated, [[refresher1], [refresher2], []]);
		});
		it("throws for missing refreshers in first data change", () => {
			const input: MockChange[] = [{ relevant: [idNotInForest] }];
			assert.throws(() => testUpdateRefreshers(input));
		});
		it("tolerates missing refreshers in later data changes", () => {
			const input: MockChange[] = [
				{ relevant: [idInForest1] },
				{ relevant: [idNotInForest, idInForest2] },
			];
			const updated = testUpdateRefreshers(input);
			assert.deepEqual(updated, [[refresher1], [refresher2]]);
		});
	});

	describe("changeRevision", () => {
		it("handles local ID collisions across separate changes", () => {
			function getIds(change: SharedTreeChange): [DeltaDetachedNodeId, DeltaDetachedNodeId] {
				const change1 = change.changes[0];
				const change3 = change.changes[2];
				assert.equal(change1.type, "data");
				assert.equal(change3.type, "data");
				const delta1 = intoDelta(tagChange(change1.innerChange, undefined));
				const delta3 = intoDelta(tagChange(change3.innerChange, undefined));
				const id1 = delta1.build?.[0]?.id ?? fail("Missing id");
				const id3 = delta3.build?.[0]?.id ?? fail("Missing id");
				return [id1, id3];
			}
			const input: SharedTreeChange = {
				changes: [
					{ type: "data", innerChange: dataChange1 },
					{ type: "schema", innerChange: innerSchemaChange },
					{ type: "data", innerChange: dataChange2 },
				],
			};
			// Check the test setup is correct
			{
				const [a, b] = getIds(input);
				assert.notEqual(a.major, b.major);
				assert.equal(a.minor, b.minor);
			}
			const newRevision = mintRevisionTag();
			const updated = sharedTreeFamily.changeRevision(
				input,
				new DefaultRevisionReplacer(newRevision, sharedTreeFamily.getRevisions(input)),
			);
			// Check the revision change had the intended effect
			{
				const [a, b] = getIds(updated);
				assert.equal(a.major, newRevision);
				assert.equal(b.major, newRevision);
				assert.notEqual(a.minor, b.minor);
			}
		});

		it("keeps atom IDs consistent across separate changes", () => {
			function checkConsistency(change: SharedTreeChange): void {
				const change1 = change.changes[0];
				const change3 = change.changes[2];
				assert.equal(change1.type, "data");
				assert.equal(change3.type, "data");
				const delta1 = intoDelta(tagChange(change1.innerChange, undefined));
				const delta3 = intoDelta(tagChange(change3.innerChange, undefined));
				const detachedNodeId = delta1.fields?.get(rootFieldKey)?.marks[0]?.detach;
				const reference = delta3.rename?.[0]?.oldId;
				assert.notEqual(reference, undefined);
				assert.deepEqual(reference, detachedNodeId);
			}
			const input: SharedTreeChange = {
				changes: [
					{ type: "data", innerChange: dataChange3 },
					{ type: "schema", innerChange: innerSchemaChange },
					{ type: "data", innerChange: rebasedDataChange4 },
				],
			};
			checkConsistency(input);
			const newRevision = mintRevisionTag();
			const updated = sharedTreeFamily.changeRevision(
				input,
				new DefaultRevisionReplacer(newRevision, sharedTreeFamily.getRevisions(input)),
			);
			checkConsistency(updated);
		});
	});

	describe("bundle rebase (schema + data changes)", () => {
		// Test schemas for allowsRepoSuperset checks (Cases 7/9)
		const schemaA: TreeStoredSchema = {
			nodeSchema: new Map(),
			rootFieldSchema: {
				kind: FieldKinds.optional.identifier,
				types: new Set(["typeA" as TreeNodeSchemaIdentifier]),
				persistedMetadata: undefined,
			},
		};
		const schemaB: TreeStoredSchema = {
			nodeSchema: new Map(),
			rootFieldSchema: {
				kind: FieldKinds.optional.identifier,
				types: new Set([
					"typeA" as TreeNodeSchemaIdentifier,
					"typeB" as TreeNodeSchemaIdentifier,
				]),
				persistedMetadata: undefined,
			},
		};
		const schemaC: TreeStoredSchema = {
			nodeSchema: new Map(),
			rootFieldSchema: {
				kind: FieldKinds.optional.identifier,
				types: new Set(["typeC" as TreeNodeSchemaIdentifier]),
				persistedMetadata: undefined,
			},
		};

		// Verify test schema setup
		it("test schema setup: allowsRepoSuperset relationships", () => {
			// B is superset of A (A's types are subset of B's types)
			assert.equal(allowsRepoSuperset(defaultSchemaPolicy, schemaA, schemaB), true);
			// C is NOT superset of A (C has typeC, A needs typeA)
			assert.equal(allowsRepoSuperset(defaultSchemaPolicy, schemaA, schemaC), false);
			// A is NOT superset of B (A lacks typeB)
			assert.equal(allowsRepoSuperset(defaultSchemaPolicy, schemaB, schemaA), false);
		});

		// Schema changes for bundle construction
		const expansiveSchemaChange: SchemaChange = {
			schema: { new: schemaB, old: schemaA },
			isInverse: false,
			isExpansive: true,
			upgradeBundle: true,
		};
		const restrictiveSchemaChange: SchemaChange = {
			schema: { new: schemaA, old: schemaB },
			isInverse: false,
			isExpansive: false,
			upgradeBundle: true,
		};
		const schemaChangeAtoB: SchemaChange = {
			schema: { new: schemaB, old: emptySchema },
			isInverse: false,
		};
		const schemaChangeAtoC: SchemaChange = {
			schema: { new: schemaC, old: emptySchema },
			isInverse: false,
		};

		// Bundle changes: schema + data (produced by upgradeSchemaOnNextEdit)
		const bundleChangeA: SharedTreeChange = {
			changes: [
				{
					type: "schema",
					innerChange: {
						schema: { new: schemaA, old: emptySchema },
						isInverse: false,
						upgradeBundle: true,
					},
				},
				{ type: "data", innerChange: dataChange1 },
			],
		};
		const bundleChangeB: SharedTreeChange = {
			changes: [
				{
					type: "schema",
					innerChange: {
						schema: { new: schemaB, old: emptySchema },
						isInverse: false,
						upgradeBundle: true,
					},
				},
				{ type: "data", innerChange: dataChange1 },
			],
		};

		// Bundle with expansive schema (for Case 6a)
		const expansiveBundleChange: SharedTreeChange = {
			changes: [
				{ type: "schema", innerChange: expansiveSchemaChange },
				{ type: "data", innerChange: dataChange1 },
			],
		};

		// Bundle with restrictive schema (for Case 6b)
		const restrictiveBundleChange: SharedTreeChange = {
			changes: [
				{ type: "schema", innerChange: restrictiveSchemaChange },
				{ type: "data", innerChange: dataChange1 },
			],
		};

		// Schema-only changes (for Cases 7, 8)
		const schemaOnlyB: SharedTreeChange = {
			changes: [{ type: "schema", innerChange: schemaChangeAtoB }],
		};
		const schemaOnlyC: SharedTreeChange = {
			changes: [{ type: "schema", innerChange: schemaChangeAtoC }],
		};

		describe("Case 5: Bundle over data-only", () => {
			it("preserves schema and rebases data", () => {
				const result = sharedTreeFamily.rebase(
					makeAnonChange(bundleChangeA),
					makeAnonChange(stDataChange2),
					revisionMetadataSourceFromInfo([]),
				);
				// Schema should be preserved, data should be rebased
				assert.equal(result.changes.length, 2);
				const schemaResult = result.changes[0];
				const dataResult = result.changes[1];
				assert.equal(schemaResult.type, "schema");
				assert.deepEqual(schemaResult, bundleChangeA.changes[0]);
				assert.equal(dataResult.type, "data");
				// Data should be rebased over the data-only change
				assert.deepEqual(
					dataResult.innerChange,
					modularFamily.rebase(
						makeAnonChange(dataChange1),
						makeAnonChange(dataChange2),
						revisionMetadataSourceFromInfo([]),
					),
				);
			});
		});

		describe("Case 6: Data-only over bundle", () => {
			it("6a: rebases data when bundle has expansive schema", () => {
				const result = sharedTreeFamily.rebase(
					makeAnonChange(stDataChange2),
					makeAnonChange(expansiveBundleChange),
					revisionMetadataSourceFromInfo([]),
				);
				// Data should be rebased over the data portion of the bundle
				assert.equal(result.changes.length, 1);
				assert.equal(result.changes[0].type, "data");
				assert.deepEqual(
					result.changes[0].innerChange,
					modularFamily.rebase(
						makeAnonChange(dataChange2),
						makeAnonChange(dataChange1),
						revisionMetadataSourceFromInfo([]),
					),
				);
			});

			it("6b: drops data when bundle has restrictive schema", () => {
				const result = sharedTreeFamily.rebase(
					makeAnonChange(stDataChange2),
					makeAnonChange(restrictiveBundleChange),
					revisionMetadataSourceFromInfo([]),
				);
				assert.deepEqual(result, { changes: [] });
			});

			it("6b: drops data when bundle schema is inverse", () => {
				const inverseBundleChange: SharedTreeChange = {
					changes: [
						{
							type: "schema",
							innerChange: {
								schema: { new: schemaA, old: schemaB },
								isInverse: true,
								isExpansive: false,
								upgradeBundle: true,
							},
						},
						{ type: "data", innerChange: dataChange1 },
					],
				};
				const result = sharedTreeFamily.rebase(
					makeAnonChange(stDataChange2),
					makeAnonChange(inverseBundleChange),
					revisionMetadataSourceFromInfo([]),
				);
				assert.deepEqual(result, { changes: [] });
			});
		});

		describe("Case 7: Bundle over schema-only", () => {
			it("preserves data when their schema is a superset of ours", () => {
				// bundleChangeA has new schema = schemaA
				// schemaOnlyB has new schema = schemaB (superset of A)
				const result = sharedTreeFamily.rebase(
					makeAnonChange(bundleChangeA),
					makeAnonChange(schemaOnlyB),
					revisionMetadataSourceFromInfo([]),
				);
				// Our schema is dropped (redundant), our data is preserved
				assert.equal(result.changes.length, 1);
				assert.equal(result.changes[0].type, "data");
			});

			it("drops bundle when their schema is incompatible", () => {
				// bundleChangeA has new schema = schemaA
				// schemaOnlyC has new schema = schemaC (incompatible with A)
				const result = sharedTreeFamily.rebase(
					makeAnonChange(bundleChangeA),
					makeAnonChange(schemaOnlyC),
					revisionMetadataSourceFromInfo([]),
				);
				assert.deepEqual(result, { changes: [] });
			});
		});

		describe("Case 8: Schema-only over bundle", () => {
			it("drops the schema-only change", () => {
				const result = sharedTreeFamily.rebase(
					makeAnonChange(stSchemaChange),
					makeAnonChange(expansiveBundleChange),
					revisionMetadataSourceFromInfo([]),
				);
				assert.deepEqual(result, { changes: [] });
			});
		});

		describe("Case 9: Bundle over bundle", () => {
			it("preserves data when their schema is a superset of ours", () => {
				// bundleChangeA has new schema = schemaA
				// bundleChangeB has new schema = schemaB (superset of A)
				const result = sharedTreeFamily.rebase(
					makeAnonChange(bundleChangeA),
					makeAnonChange(bundleChangeB),
					revisionMetadataSourceFromInfo([]),
				);
				// Our schema is dropped, our data is preserved
				assert.equal(result.changes.length, 1);
				assert.equal(result.changes[0].type, "data");
			});

			it("drops bundle when schemas are incompatible", () => {
				// bundleChangeA has new schema = schemaA
				// Create a bundle with schemaC (incompatible)
				const bundleChangeC: SharedTreeChange = {
					changes: [
						{
							type: "schema",
							innerChange: {
								schema: { new: schemaC, old: emptySchema },
								isInverse: false,
								upgradeBundle: true,
							},
						},
						{ type: "data", innerChange: dataChange2 },
					],
				};
				const result = sharedTreeFamily.rebase(
					makeAnonChange(bundleChangeA),
					makeAnonChange(bundleChangeC),
					revisionMetadataSourceFromInfo([]),
				);
				assert.deepEqual(result, { changes: [] });
			});
		});

		describe("existing behavior preserved", () => {
			it("non-bundle schema changes still conflict with all changes", () => {
				// Schema-only over data-only (Case 2) — unchanged
				assert.deepEqual(
					sharedTreeFamily.rebase(
						makeAnonChange(stSchemaChange),
						makeAnonChange(stDataChange1),
						revisionMetadataSourceFromInfo([]),
					),
					{ changes: [] },
				);

				// Data-only over schema-only (Case 3) — unchanged
				assert.deepEqual(
					sharedTreeFamily.rebase(
						makeAnonChange(stDataChange1),
						makeAnonChange(stSchemaChange),
						revisionMetadataSourceFromInfo([]),
					),
					{ changes: [] },
				);

				// Schema-only over schema-only (Case 4) — unchanged
				assert.deepEqual(
					sharedTreeFamily.rebase(
						makeAnonChange(stSchemaChange),
						makeAnonChange(stSchemaChange),
						revisionMetadataSourceFromInfo([]),
					),
					{ changes: [] },
				);
			});

			it("data-only over data-only still rebases normally (Case 1)", () => {
				const result = sharedTreeFamily.rebase(
					makeAnonChange(stDataChange1),
					makeAnonChange(stDataChange2),
					revisionMetadataSourceFromInfo([]),
				);
				assert.deepEqual(result, {
					changes: [
						{
							type: "data",
							innerChange: modularFamily.rebase(
								makeAnonChange(dataChange1),
								makeAnonChange(dataChange2),
								revisionMetadataSourceFromInfo([]),
							),
						},
					],
				});
			});

			it("empty changes still result in no-op rebases", () => {
				// Bundle over empty
				assert.deepEqual(
					sharedTreeFamily.rebase(
						makeAnonChange(bundleChangeA),
						makeAnonChange(stEmptyChange),
						revisionMetadataSourceFromInfo([]),
					),
					bundleChangeA,
				);

				// Empty over bundle
				assert.deepEqual(
					sharedTreeFamily.rebase(
						makeAnonChange(stEmptyChange),
						makeAnonChange(expansiveBundleChange),
						revisionMetadataSourceFromInfo([]),
					),
					stEmptyChange,
				);
			});
		});
	});
});
