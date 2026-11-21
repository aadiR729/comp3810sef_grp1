'use strict';

const { ObjectId } = require('mongodb');
const ApiError = require('./apiError');

const HEX_24 = /^[0-9a-fA-F]{24}$/;

/**
 * Turns a string from the URL or request body into an ObjectId.
 * Throws a friendly 400 instead of letting the driver explode on bad input.
 */
function toObjectId(value, label = 'id') {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (!HEX_24.test(text)) {
        throw ApiError.badRequest(
            `"${text || '(empty)'}" is not a valid ${label}. Please check it and try again.`,
            'INVALID_ID'
        );
    }
    return new ObjectId(text);
}

/**
 * The node MongoDB driver (v6 and later) returns the document itself from
 * findOneAndUpdate / findOneAndDelete; older versions wrapped it in { value }.
 * This normalises both shapes.
 */
function unwrapDoc(result) {
    if (!result) return null;
    if (result.value && typeof result.value === 'object' && result._id === undefined) {
        return result.value;
    }
    return result;
}

module.exports = { toObjectId, unwrapDoc };
