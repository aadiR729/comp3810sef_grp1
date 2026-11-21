'use strict';

/**
 * Small helpers shared by the /api/books and /api/loans routers.
 */

/** Every successful response uses the same envelope: { success, message?, data }. */
function sendData(res, data, { status = 200, message, extra } = {}) {
    const body = { success: true };
    if (message) body.message = message;
    body.data = data;
    if (extra) Object.assign(body, extra);
    return res.status(status).json(body);
}

/** Reads ?page= and ?limit= safely (limit is capped so one request cannot dump the DB). */
function pagination(query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
    const parsedPage = Number.parseInt(query.page, 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

    const parsedLimit = Number.parseInt(query.limit, 10);
    const limit = Number.isFinite(parsedLimit)
        ? Math.min(maxLimit, Math.max(1, parsedLimit))
        : defaultLimit;

    return { page, limit, skip: (page - 1) * limit };
}

function meta(total, page, limit) {
    return { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** ?available=true / 1 / yes -> true */
function queryBoolean(value) {
    if (value === undefined || value === null || value === '') return undefined;
    return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

module.exports = { sendData, pagination, meta, queryBoolean };
