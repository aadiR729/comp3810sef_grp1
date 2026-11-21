'use strict';

/**
 * Error type used by the REST API.
 *
 * Services and routes throw it, and the API error handler in
 * routes/api/index.js turns it into a JSON response such as:
 *
 *   { "success": false, "error": "Out of stock!", "code": "OUT_OF_STOCK" }
 *
 * `code` is a stable, machine-readable value so the frontend (Person 4) can
 * show a friendly message without string-matching the error text.
 */
class ApiError extends Error {
    constructor(status, message, code = 'API_ERROR', details = undefined) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }

    static badRequest(message, code = 'VALIDATION_ERROR') {
        return new ApiError(400, message, code);
    }

    static unauthenticated(message = 'Please log in to continue.') {
        return new ApiError(401, message, 'UNAUTHENTICATED');
    }

    static forbidden(message = 'You are not allowed to do that.') {
        return new ApiError(403, message, 'FORBIDDEN');
    }

    static notFound(message = 'We could not find what you were looking for.', code = 'NOT_FOUND') {
        return new ApiError(404, message, code);
    }

    static conflict(message, code = 'CONFLICT') {
        return new ApiError(409, message, code);
    }
}

module.exports = ApiError;
