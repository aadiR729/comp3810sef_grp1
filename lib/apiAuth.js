'use strict';

const ApiError = require('./apiError');

const LIBRARIAN_ROLES = new Set(['librarian', 'admin', 'staff']);

/**
 * Reads the logged-in user out of the express-session store.
 *
 * Contract with Person 2 (Authentication):
 *   the login route should store the user as
 *     req.session.user = { _id | id, username, role }
 *   or in the flatter form
 *     req.session.userId = ..., req.session.username = ..., req.session.role = ...
 *
 * Both shapes are accepted so the API keeps working whichever style lands.
 * Returns null when nobody is logged in (or when session middleware is missing).
 */
function getSessionUser(req) {
    const session = req.session;
    if (!session) return null;

    const raw = session.user;

    if (raw && typeof raw === 'object') {
        const id = raw._id ?? raw.id ?? raw.userId ?? raw.username;
        if (id === undefined || id === null) return null;
        return {
            id: String(id),
            username: String(raw.username ?? raw.name ?? 'unknown'),
            role: String(raw.role ?? 'member').toLowerCase(),
            raw
        };
    }

    const flatId = session.userId ?? (typeof raw === 'string' ? raw : undefined);
    if (flatId === undefined || flatId === null) return null;
    return {
        id: String(flatId),
        username: String(session.username ?? 'unknown'),
        role: String(session.role ?? 'member').toLowerCase(),
        raw: null
    };
}

function isLibrarian(user) {
    return Boolean(user) && LIBRARIAN_ROLES.has(user.role);
}

/** Throws a 401 JSON error when the visitor is not logged in. */
function requireUser(req) {
    const user = getSessionUser(req);
    if (!user) throw ApiError.unauthenticated('Please log in to use the library API.');
    return user;
}

/** Throws 401 when not logged in, 403 when logged in but not a librarian. */
function requireLibrarian(req) {
    const user = requireUser(req);
    if (!isLibrarian(user)) {
        throw ApiError.forbidden('Only the librarian can change the book catalog.');
    }
    return user;
}

module.exports = { getSessionUser, isLibrarian, requireUser, requireLibrarian };
