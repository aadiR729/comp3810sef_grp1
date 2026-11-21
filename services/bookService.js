'use strict';

const { getDB } = require('../db/db');
const ApiError = require('../lib/apiError');
const { toObjectId, unwrapDoc } = require('../lib/mongo');

const MAX_TEXT = 200;
const MAX_COPIES = 999;

function books() {
    return getDB().collection('books');
}

function loans() {
    return getDB().collection('loans');
}

/** Escapes user input so "Clean Code?" cannot break the search regex. */
function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanText(value, field, { required = true, max = MAX_TEXT } = {}) {
    if (value === undefined || value === null) {
        if (required) throw ApiError.badRequest(`Please provide a ${field}.`);
        return undefined;
    }
    const text = String(value).trim();
    if (!text) {
        if (required) throw ApiError.badRequest(`Please provide a ${field}.`);
        return undefined;
    }
    if (text.length > max) {
        throw ApiError.badRequest(`The ${field} is too long (maximum ${max} characters).`);
    }
    return text;
}

function cleanCopies(value, field = 'totalCopies') {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw ApiError.badRequest(`The ${field} must be a whole number of 0 or more.`);
    }
    if (number > MAX_COPIES) {
        throw ApiError.badRequest(`That is more copies than we track (maximum ${MAX_COPIES}).`);
    }
    return number;
}

/** The JSON shape of a book that the API (and the EJS pages) can rely on. */
function serializeBook(book) {
    const totalCopies = Number(book.totalCopies) || 0;
    const availableCopies = Number(book.availableCopies) || 0;
    return {
        id: String(book._id),
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        category: book.category || 'General',
        totalCopies,
        availableCopies,
        onLoanCopies: Math.max(0, totalCopies - availableCopies),
        inStock: availableCopies > 0,
        createdAt: book.createdAt ? new Date(book.createdAt).toISOString() : null,
        updatedAt: book.updatedAt ? new Date(book.updatedAt).toISOString() : null
    };
}

/**
 * GET /api/books
 * `search` matches title, author or ISBN (case-insensitive, partial match),
 * which is what the search bar on the catalog page needs.
 */
async function listBooks({ search, category, onlyAvailable, page = 1, limit = 20 } = {}) {
    const filter = {};

    const term = search === undefined || search === null ? '' : String(search).trim();
    if (term) {
        const rx = new RegExp(escapeRegex(term), 'i');
        filter.$or = [{ title: rx }, { author: rx }, { isbn: rx }];
    }

    const categoryText = category === undefined || category === null ? '' : String(category).trim();
    if (categoryText) filter.category = categoryText;

    if (onlyAvailable) filter.availableCopies = { $gt: 0 };

    const collection = books();
    const total = await collection.countDocuments(filter);
    const docs = await collection
        .find(filter)
        .sort({ title: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray();

    return { items: docs.map(serializeBook), total };
}

async function getBook(id) {
    const book = await books().findOne({ _id: toObjectId(id, 'book id') });
    if (!book) throw ApiError.notFound('We could not find that book.', 'BOOK_NOT_FOUND');
    return serializeBook(book);
}

async function createBook(payload = {}) {
    const title = cleanText(payload.title, 'title');
    const author = cleanText(payload.author, 'author');
    const isbn = cleanText(payload.isbn, 'ISBN');
    const category = cleanText(payload.category, 'category', { required: false }) || 'General';
    const requested = cleanCopies(payload.totalCopies);
    const totalCopies = requested === undefined ? 1 : requested;

    if (totalCopies < 1) throw ApiError.badRequest('A book needs at least 1 copy.');

    const book = {
        title,
        author,
        isbn,
        category,
        totalCopies,
        availableCopies: totalCopies,
        createdAt: new Date()
    };

    try {
        const result = await books().insertOne(book);
        book._id = result.insertedId;
    } catch (error) {
        if (error && error.code === 11000) {
            throw ApiError.conflict(`A book with ISBN "${isbn}" is already in the catalog.`, 'DUPLICATE_ISBN');
        }
        throw error;
    }

    return serializeBook(book);
}

/**
 * PUT /api/books/:id
 * Changing totalCopies keeps the numbers honest: the copies currently on loan
 * must always stay available to the members who borrowed them.
 */
async function updateBook(id, payload = {}) {
    const _id = toObjectId(id, 'book id');
    const collection = books();

    const book = await collection.findOne({ _id });
    if (!book) throw ApiError.notFound('We could not find that book.', 'BOOK_NOT_FOUND');

    const updates = {};
    if (payload.title !== undefined) updates.title = cleanText(payload.title, 'title');
    if (payload.author !== undefined) updates.author = cleanText(payload.author, 'author');
    if (payload.isbn !== undefined) updates.isbn = cleanText(payload.isbn, 'ISBN');
    if (payload.category !== undefined) {
        updates.category = cleanText(payload.category, 'category', { required: false }) || 'General';
    }

    const requestedTotal = cleanCopies(payload.totalCopies);
    if (requestedTotal !== undefined) {
        if (requestedTotal < 1) throw ApiError.badRequest('A book needs at least 1 copy.');

        const currentTotal = Number(book.totalCopies) || 0;
        const currentAvailable = Number(book.availableCopies) || 0;
        const onLoan = Math.max(0, currentTotal - currentAvailable);

        if (requestedTotal < onLoan) {
            throw ApiError.conflict(
                `Right now ${onLoan} ${onLoan === 1 ? 'copy is' : 'copies are'} on loan, ` +
                    `so the total cannot be lower than ${onLoan}.`,
                'COPIES_ON_LOAN'
            );
        }

        updates.totalCopies = requestedTotal;
        updates.availableCopies = requestedTotal - onLoan;
    }

    if (Object.keys(updates).length === 0) {
        throw ApiError.badRequest(
            'Nothing to update. Send at least one of: title, author, isbn, category, totalCopies.'
        );
    }

    updates.updatedAt = new Date();

    let updated;
    try {
        updated = await collection.findOneAndUpdate({ _id }, { $set: updates }, { returnDocument: 'after' });
    } catch (error) {
        if (error && error.code === 11000) {
            throw ApiError.conflict(`A book with ISBN "${updates.isbn}" is already in the catalog.`, 'DUPLICATE_ISBN');
        }
        throw error;
    }

    return serializeBook(unwrapDoc(updated));
}

/**
 * DELETE /api/books/:id
 * A book with copies still on loan cannot be deleted, otherwise those loans
 * would point at nothing.
 */
async function deleteBook(id) {
    const _id = toObjectId(id, 'book id');

    const activeLoans = await loans().countDocuments({ bookId: _id, returnedAt: null });
    if (activeLoans > 0) {
        throw ApiError.conflict(
            `This book still has ${activeLoans} ${activeLoans === 1 ? 'copy' : 'copies'} on loan. ` +
                'Take them back before deleting it.',
            'BOOK_ON_LOAN'
        );
    }

    const deleted = await books().findOneAndDelete({ _id });
    if (!deleted) throw ApiError.notFound('We could not find that book.', 'BOOK_NOT_FOUND');

    return serializeBook(unwrapDoc(deleted));
}

module.exports = {
    MAX_TEXT,
    MAX_COPIES,
    escapeRegex,
    serializeBook,
    listBooks,
    getBook,
    createBook,
    updateBook,
    deleteBook
};
