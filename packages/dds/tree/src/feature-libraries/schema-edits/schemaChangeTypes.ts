/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { TreeStoredSchema } from "../../core/index.js";

/**
 * A change that updates the schema of a Shared Tree.
 */
export interface SchemaChange {
	/**
	 * This property contains the new stored schema for the document and the old schema for inverting.
	 */
	readonly schema: { new: TreeStoredSchema; old: TreeStoredSchema };

	/**
	 * Whether this change reverses a previous schema change.
	 * While non-inverse changes are expected to be backwards compatible, inverse changes are not.
	 */
	readonly isInverse: boolean;

	/**
	 * Whether this schema change is expansive (the new schema is a superset of the old schema).
	 * Computed at hydration time from `allowsRepoSuperset(old, new)`, not serialized in the op format.
	 * Used during rebase to determine if data changes can safely rebase over this schema change.
	 */
	readonly isExpansive?: boolean;

	/**
	 * Whether this schema change is part of an upgrade bundle produced by `upgradeSchemaOnNextEdit()`.
	 * When true, the bundled change (schema + data).
	 * Serialized in the v3 op format as the `upgradeBundle` field on `EncodedSchemaChangeV3`.
	 */
	readonly upgradeBundle?: boolean;
}
