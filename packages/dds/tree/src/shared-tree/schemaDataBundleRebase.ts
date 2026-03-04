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
	allowsRepoSuperset,
	defaultSchemaPolicy,
} from "../feature-libraries/index.js";

import type { SharedTreeChange, SharedTreeInnerChange } from "./sharedTreeChangeTypes.js";

/**
 * Returns true iff the given change contains at least one data (non-schema) inner change.
 * Counterpart to the existing `hasSchemaChange()`.
 */
export function hasDataChange(change: SharedTreeChange): boolean {
	return change.changes.some((innerChange) => innerChange.type === "data");
}

/**
 * Returns true iff the given change is an upgrade bundle: a change containing both
 * schema and data inner changes where the schema change has the `upgradeBundle` flag set.
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
 * Rebase helpers for bundled changes (schema + data produced by `upgradeSchemaOnNextEdit()`).
 * Implements Cases 5-9 from the rebase table.
 */
export function rebaseBundled(
	modularChangeFamily: ModularChangeFamily,
	change: TaggedChange<SharedTreeChange>,
	over: TaggedChange<SharedTreeChange>,
	revisionMetadata: RevisionMetadataSource,
	changeHasSchema: boolean,
	overHasSchema: boolean,
	changeIsBundle: boolean,
	overIsBundle: boolean,
): SharedTreeChange {
	// Case 5: Bundle over data-only → schema preserved, data rebased
	if (changeIsBundle && !overHasSchema) {
		return rebasePreservingSchema(modularChangeFamily, change, over, revisionMetadata);
	}

	// Case 6a/6b: Data-only over bundle
	if (!changeHasSchema && overIsBundle) {
		if (isExpansiveSchemaChange(over.change)) {
			return rebaseDataOverExpandedSchema(modularChangeFamily, change, over, revisionMetadata);
		}
		return { changes: [] }; // 6b: restrictive → drop
	}

	// Cases 7, 9: Bundle over schema-only or bundle over bundle
	if (changeIsBundle && overHasSchema) {
		const ourSchema = getNewSchema(change.change);
		const theirSchema = getNewSchema(over.change);

		if (allowsRepoSuperset(defaultSchemaPolicy, ourSchema, theirSchema)) {
			// Their schema supports ours — drop our schema, rebase our data
			return rebaseDataOnly(modularChangeFamily, change, over, revisionMetadata);
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
 * Case 5: Our bundle rebases over their data-only change.
 * Schema is preserved unchanged, data is rebased over their data.
 */
function rebasePreservingSchema(
	modularChangeFamily: ModularChangeFamily,
	change: TaggedChange<SharedTreeChange>,
	over: TaggedChange<SharedTreeChange>,
	revisionMetadata: RevisionMetadataSource,
): SharedTreeChange {
	const schemaChanges = change.change.changes.filter(
		(c): c is Extract<SharedTreeInnerChange, { type: "schema" }> => c.type === "schema",
	);
	const ourDataChanges = change.change.changes.filter(
		(c): c is Extract<SharedTreeInnerChange, { type: "data" }> => c.type === "data",
	);

	const overDataChanges = over.change.changes
		.filter((c): c is Extract<SharedTreeInnerChange, { type: "data" }> => c.type === "data")
		.map((c) => mapTaggedChange(over, c.innerChange));

	if (overDataChanges.length === 0) {
		return change.change;
	}

	const composedOver = modularChangeFamily.compose(overDataChanges);

	const rebasedDataChanges: SharedTreeInnerChange[] = [];
	for (const innerChange of ourDataChanges) {
		const rebasedData = modularChangeFamily.rebase(
			mapTaggedChange(change, innerChange.innerChange),
			makeAnonChange(composedOver),
			revisionMetadata,
		);
		rebasedDataChanges.push({ type: "data", innerChange: rebasedData });
	}

	return { changes: [...schemaChanges, ...rebasedDataChanges] };
}

/**
 * Cases 7/9: Our bundle rebases over their schema-only or bundle change,
 * and their schema is a superset of ours. Drop our schema, rebase our data.
 */
function rebaseDataOnly(
	modularChangeFamily: ModularChangeFamily,
	change: TaggedChange<SharedTreeChange>,
	over: TaggedChange<SharedTreeChange>,
	revisionMetadata: RevisionMetadataSource,
): SharedTreeChange {
	const ourDataChanges = change.change.changes.filter(
		(c): c is Extract<SharedTreeInnerChange, { type: "data" }> => c.type === "data",
	);
	const overDataChanges = over.change.changes
		.filter((c): c is Extract<SharedTreeInnerChange, { type: "data" }> => c.type === "data")
		.map((c) => mapTaggedChange(over, c.innerChange));

	if (overDataChanges.length === 0) {
		return { changes: ourDataChanges };
	}

	const composedOver = modularChangeFamily.compose(overDataChanges);

	const rebasedChanges: SharedTreeInnerChange[] = [];
	for (const innerChange of ourDataChanges) {
		const rebasedData = modularChangeFamily.rebase(
			mapTaggedChange(change, innerChange.innerChange),
			makeAnonChange(composedOver),
			revisionMetadata,
		);
		rebasedChanges.push({ type: "data", innerChange: rebasedData });
	}

	return { changes: rebasedChanges };
}

/**
 * Case 6a: Data-only change rebases over a bundle with an expansive schema.
 * The schema expansion is safe, so the data is rebased over the data portion of the bundle.
 */
function rebaseDataOverExpandedSchema(
	modularChangeFamily: ModularChangeFamily,
	change: TaggedChange<SharedTreeChange>,
	over: TaggedChange<SharedTreeChange>,
	revisionMetadata: RevisionMetadataSource,
): SharedTreeChange {
	const overDataChanges = over.change.changes
		.filter((c): c is Extract<SharedTreeInnerChange, { type: "data" }> => c.type === "data")
		.map((c) => mapTaggedChange(over, c.innerChange));

	if (overDataChanges.length === 0) {
		return change.change;
	}

	const composedOver = modularChangeFamily.compose(overDataChanges);
	const rebasedChanges: SharedTreeInnerChange[] = [];

	for (const innerChange of change.change.changes) {
		assert(innerChange.type === "data", "Expected data-only change in rebasePreservingSchema");
		const rebasedData = modularChangeFamily.rebase(
			mapTaggedChange(change, innerChange.innerChange),
			makeAnonChange(composedOver),
			revisionMetadata,
		);
		rebasedChanges.push({ type: "data", innerChange: rebasedData });
	}

	return { changes: rebasedChanges };
}
