/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";

import {
	type RevisionMetadataSource,
	type TaggedChange,
	type TreeStoredSchema,
	makeAnonChange,
	mapTaggedChange,
} from "../core/index.js";
import {
	type ModularChangeFamily,
	type ModularChangeset,
	allowsRepoSuperset,
	defaultSchemaPolicy,
} from "../feature-libraries/index.js";

import type { SharedTreeChange, SharedTreeInnerChange } from "./sharedTreeChangeTypes.js";

/**
 * Returns true iff the given change is an upgrade bundle: a change containing
 * a schema change with the `upgradeBundle` flag set.
 * This distinguishes `upgradeSchemaOnNextEdit()` bundles from `initialize()` bundles.
 */
export function isUpgradeBundle(change: SharedTreeChange): boolean {
	return change.changes.some(
		(c) => c.type === "schema" && c.innerChange.upgradeBundle === true,
	);
}

/**
 * Extracts the effective new schema from a change.
 * Returns the LAST schema change's `.new` schema, since a composed change like
 * `[schema V1→V2, data, schema V2→V3]` has effective new schema V3.
 */
function getNewSchema(change: SharedTreeChange): TreeStoredSchema {
	let lastNewSchema: TreeStoredSchema | undefined;
	for (const innerChange of change.changes) {
		if (innerChange.type === "schema") {
			lastNewSchema = innerChange.innerChange.schema.new;
		}
	}
	assert(lastNewSchema !== undefined, "Expected at least one schema change in bundle");
	return lastNewSchema;
}

/**
 * Checks if all schema changes in a `SharedTreeChange` are expansive (non-inverse and
 * the new schema is a superset of the old schema). Used for Case 6a/6b.
 *
 * `isExpansive` may be pre-computed (by the v3 codec during decode) or absent
 * (for locally-created changes that were never serialized). When absent, it is
 * computed on the fly from the schema pair to ensure consistent results regardless
 * of whether the change originated locally or was received over the wire.
 */
function isExpansiveSchemaChange(change: SharedTreeChange): boolean {
	let foundSchema = false;
	for (const innerChange of change.changes) {
		if (innerChange.type === "schema") {
			foundSchema = true;
			if (innerChange.innerChange.isInverse) {
				return false;
			}
			const expansive =
				innerChange.innerChange.isExpansive ??
				allowsRepoSuperset(
					defaultSchemaPolicy,
					innerChange.innerChange.schema.old,
					innerChange.innerChange.schema.new,
				);
			if (!expansive) {
				return false;
			}
		}
	}
	return foundSchema;
}

/**
 * Rebase logic for bundled changes (schema + data produced by `upgradeSchemaOnNextEdit()`).
 * Implements Cases 5-9 from the rebase table.
 */
export function rebaseBundled(
	modularChangeFamily: ModularChangeFamily,
	change: TaggedChange<SharedTreeChange>,
	over: TaggedChange<SharedTreeChange>,
	revisionMetadata: RevisionMetadataSource,
): SharedTreeChange {
	const changeIsBundle = isUpgradeBundle(change.change);
	const overIsBundle = isUpgradeBundle(over.change);
	const changeHasSchema = change.change.changes.some((c) => c.type === "schema");
	const overHasSchema = over.change.changes.some((c) => c.type === "schema");

	// Case 5: Bundle over data-only → schema preserved, data rebased
	if (changeIsBundle && !overHasSchema) {
		return rebaseDataChanges(modularChangeFamily, change, over, revisionMetadata, true);
	}

	// Case 6a/6b: Data-only over bundle
	if (!changeHasSchema && overIsBundle) {
		if (isExpansiveSchemaChange(over.change)) {
			return rebaseDataChanges(modularChangeFamily, change, over, revisionMetadata, false);
		}
		return { changes: [] }; // 6b: restrictive → drop
	}

	// Cases 7, 9: Bundle over schema-only or bundle over bundle
	if (changeIsBundle && overHasSchema) {
		const ourSchema = getNewSchema(change.change);
		const theirSchema = getNewSchema(over.change);

		if (allowsRepoSuperset(defaultSchemaPolicy, ourSchema, theirSchema)) {
			// Their schema supports ours — drop our schema, rebase our data
			return rebaseDataChanges(modularChangeFamily, change, over, revisionMetadata, false);
		}
		return { changes: [] }; // Incompatible → drop
	}

	// Case 8: Schema-only over bundle → drop (no data to preserve)
	if (changeHasSchema && !changeIsBundle && overIsBundle) {
		return { changes: [] };
	}

	// Should not reach here, but safe fallback
	return { changes: [] };
}

/**
 * Rebases data changes from `change` over data changes from `over`.
 * When `preserveSchema` is true, schema changes from `change` are kept in the output.
 */
function rebaseDataChanges(
	modularChangeFamily: ModularChangeFamily,
	change: TaggedChange<SharedTreeChange>,
	over: TaggedChange<SharedTreeChange>,
	revisionMetadata: RevisionMetadataSource,
	preserveSchema: boolean,
): SharedTreeChange {
	const ourDataChanges = change.change.changes.filter(
		(c): c is Extract<SharedTreeInnerChange, { type: "data" }> => c.type === "data",
	);

	const overDataChanges = over.change.changes
		.filter((c): c is Extract<SharedTreeInnerChange, { type: "data" }> => c.type === "data")
		.map((c) => mapTaggedChange(over, c.innerChange));

	const rebasedData = rebaseDataInnerChanges(
		modularChangeFamily,
		change,
		ourDataChanges,
		overDataChanges,
		revisionMetadata,
	);

	if (preserveSchema) {
		const schemaChanges = change.change.changes.filter(
			(c): c is Extract<SharedTreeInnerChange, { type: "schema" }> => c.type === "schema",
		);
		return { changes: [...schemaChanges, ...rebasedData] };
	}
	return { changes: rebasedData };
}

/**
 * Core rebase: rebases each data inner change over the composed "over" data changes.
 * Returns the original data changes unchanged if there is nothing to rebase over.
 */
function rebaseDataInnerChanges(
	modularChangeFamily: ModularChangeFamily,
	change: TaggedChange<SharedTreeChange>,
	ourDataChanges: Extract<SharedTreeInnerChange, { type: "data" }>[],
	overDataChanges: TaggedChange<ModularChangeset>[],
	revisionMetadata: RevisionMetadataSource,
): SharedTreeInnerChange[] {
	if (overDataChanges.length === 0) {
		return ourDataChanges;
	}

	const composedOver = modularChangeFamily.compose(overDataChanges);
	return ourDataChanges.map((innerChange) => ({
		type: "data" as const,
		innerChange: modularChangeFamily.rebase(
			mapTaggedChange(change, innerChange.innerChange),
			makeAnonChange(composedOver),
			revisionMetadata,
		),
	}));
}
