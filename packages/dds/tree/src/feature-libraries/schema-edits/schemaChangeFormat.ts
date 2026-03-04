/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { type Static, Type } from "@sinclair/typebox";

import { JsonCompatibleReadOnlySchema } from "../../util/index.js";

export const EncodedSchemaChange = Type.Object({
	new: JsonCompatibleReadOnlySchema,
	old: JsonCompatibleReadOnlySchema,
});

export type EncodedSchemaChange = Static<typeof EncodedSchemaChange>;

/**
 * V3 encoded schema change format. Extends the base format with an optional
 * `upgradeBundle` flag that marks ops produced by `upgradeSchemaOnNextEdit()`.
 */
export const EncodedSchemaChangeV3 = Type.Object({
	new: JsonCompatibleReadOnlySchema,
	old: JsonCompatibleReadOnlySchema,
	upgradeBundle: Type.Optional(Type.Literal(true)),
});

export type EncodedSchemaChangeV3 = Static<typeof EncodedSchemaChangeV3>;
