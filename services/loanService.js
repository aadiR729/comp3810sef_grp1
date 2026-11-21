'use strict';

const { getDB } = require('../db/db');
const ApiError = require('../lib/apiError');
const { isLibrarian } = require('../lib/apiAuth');
const { toObjectId, unwrapDoc } = require('../lib/mongo');
const { serializeBook } = require('./bookService');

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a member may keep a book. Can be changed in .env if the lecturer asks. */
const LOAN_PERIOD_DAYS = (() => {
    const fromEnv = Number(process.env.LOAN_PERIOD_DAYS);
    return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 14;
})();

function books() {
    return getDB().collection('books');
}

function loans() {
    return getDB().collection('loans');
}

function addDays(date, days) {
    const copy = new Date(date.getTime());
    copy.setDate(copy.getDate() + days);
    return copy;
}

/** Whole days a loan is past its due date (0 when it is not late). */
function overdueDays(dueDate, endDate) {
    const ms = endDate.getTime() - dueDate.getTime();
    if (ms <= 0) return 0;
    return Math.max(1, Math.ceil(ms / DAY_MS));
}

function outOfStockError(title) {
    return ApiError.conflict(
        `Out of stock! All copies of "${title}" are currently on loan.`,
        'OUT_OF_STOCK'
    );
}

/** The JSON shape of a loan that the API (and the EJS pages) can rely on. */
function serializeLoan(loan, now = new Date()) {
    const dueDate = loan.dueDate ? new Date(loan.dueDate) : null;
    const returnedAt = loan.returnedAt ? new Date(loan.returnedAt) : null;

    const lateDays = dueDate ? overdueDays(dueDate, returnedAt || now) : 0;

    return {
        id: String(loan._id),
        userId: loan.userId === undefined || loan.userId === null ? null : String(loan.userId),
        username: loan.username === undefined ? null : loan.username,
        bookId: loan.bookId ? String(loan.bookId) : null,
        bookTitle: loan.bookTitle === undefined ? null : loan.bookTitle,
        borrowedAt: loan.borrowedAt ? new Date(loan.borrowedAt).toISOString() : null,
        dueDate: dueDate ? dueDate.toISOString() : null,
        returnedAt: returnedAt ? returnedAt.toISOString() : null,
        loanDays: loan.loanDays === undefined ? LOAN_PERIOD_DAYS : loan.loanDays,
        status: returnedAt ? 'returned' : 'active',
        isOverdue: !returnedAt && lateDays > 0,
        overdueDays: lateDays,
        wasOverdue: Boolean(returnedAt) && lateDays > 0
    };
}

/** Puts one copy back on the shelf, never more than the library owns. */
async function releaseCopy(bookId) {
    const result = await books().updateOne(
        { _id: bookId, $expr: { $lt: ['$availableCopies', '$totalCopies'] } },
        { $inc: { availableCopies: 1 } }
    );
    return result.modifiedCount === 1;
}

/**
 * POST /api/loans — borrow one copy of a book.
 *
 * Steps:
 *  1. the book must exist;
 *  2. there must be a copy on the shelf, otherwise "Out of stock!";
 *  3. the copy is reserved with a conditional update, so two people clicking
 *     at the same time can never both get the last copy;
 *  4. the loan gets a due date (today + LOAN_PERIOD_DAYS);
 *  5. if the member already has this book out, the unique index rejects the
 *     duplicate and the reserved copy is released again.
 */
async function borrowBook(user, rawBookId) {
    const bookId = toObjectId(rawBookId, 'book id');
    const booksCollection = books();
    const loansCollection = loans();

    const book = await booksCollection.findOne({ _id: bookId });
    if (!book) throw ApiError.notFound('We could not find that book.', 'BOOK_NOT_FOUND');

    if (!(Number(book.availableCopies) > 0)) throw outOfStockError(book.title);

    const reserved = unwrapDoc(
        await booksCollection.findOneAndUpdate(
            { _id: bookId, availableCopies: { $gt: 0 } },
            { $inc: { availableCopies: -1 } },
            { returnDocument: 'after' }
        )
    );
    if (!reserved) throw outOfStockError(book.title);

    const now = new Date();
    const loan = {
        userId: String(user.id),
        username: user.username,
        bookId,
        bookTitle: book.title,
        borrowedAt: now,
        dueDate: addDays(now, LOAN_PERIOD_DAYS),
        returnedAt: null,
        loanDays: LOAN_PERIOD_DAYS
    };

    try {
        const result = await loansCollection.insertOne(loan);
        loan._id = result.insertedId;
    } catch (error) {
        await releaseCopy(bookId);

        if (error && error.code === 11000) {
            throw ApiError.conflict(
                `You already have "${book.title}" on loan. Return it before borrowing another copy.`,
                'ALREADY_BORROWED'
            );
        }
        throw error;
    }

    return { loan: serializeLoan(loan, now), book: serializeBook(reserved) };
}

/**
 * PUT /api/loans/:id/return — give a book back.
 *
 * The loan is closed with a conditional update ({ returnedAt: null }), which
 * means a double click cannot return the same copy twice and inflate the stock.
 */
async function returnLoan(user, rawLoanId) {
    const loanId = toObjectId(rawLoanId, 'loan id');
    const loansCollection = loans();

    const loan = await loansCollection.findOne({ _id: loanId });
    if (!loan) throw ApiError.notFound('We could not find that loan record.', 'LOAN_NOT_FOUND');

    if (String(loan.userId) !== String(user.id) && !isLibrarian(user)) {
        throw ApiError.forbidden('You can only return books that you borrowed.');
    }

    if (loan.returnedAt) {
        const when = new Date(loan.returnedAt).toDateString();
        throw ApiError.badRequest(`This book was already returned on ${when}.`, 'ALREADY_RETURNED');
    }

    const updated = unwrapDoc(
        await loansCollection.findOneAndUpdate(
            { _id: loanId, returnedAt: null },
            { $set: { returnedAt: new Date() } },
            { returnDocument: 'after' }
        )
    );
    if (!updated) {
        throw ApiError.badRequest('This book was already returned.', 'ALREADY_RETURNED');
    }

    await releaseCopy(loan.bookId);

    const refreshed = await books().findOne({ _id: loan.bookId });
    return { loan: serializeLoan(updated), book: refreshed ? serializeBook(refreshed) : null };
}

/**
 * PUT /api/loans/:id — librarian changes a due date (renewal or correction).
 * Send { "dueDate": "2026-12-01" } or { "extendDays": 7 }.
 */
async function changeDueDate(rawLoanId, payload = {}) {
    const loanId = toObjectId(rawLoanId, 'loan id');
    const loan = await loans().findOne({ _id: loanId });
    if (!loan) throw ApiError.notFound('We could not find that loan record.', 'LOAN_NOT_FOUND');
    if (loan.returnedAt) {
        throw ApiError.badRequest('This loan is already closed, so its due date cannot be changed.', 'LOAN_CLOSED');
    }

    let dueDate;
    if (payload.dueDate !== undefined && payload.dueDate !== null && payload.dueDate !== '') {
        const parsed = new Date(payload.dueDate);
        if (Number.isNaN(parsed.getTime())) {
            throw ApiError.badRequest('"dueDate" must be a real date, for example "2026-12-01".');
        }
        dueDate = parsed;
    } else {
        const rawDays = payload.extendDays === undefined || payload.extendDays === null ? LOAN_PERIOD_DAYS : Number(payload.extendDays);
        if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 365) {
            throw ApiError.badRequest('"extendDays" must be a whole number between 1 and 365.');
        }
        const base = loan.dueDate && new Date(loan.dueDate) > new Date() ? new Date(loan.dueDate) : new Date();
        dueDate = addDays(base, rawDays);
    }

    const updated = unwrapDoc(
        await loans().findOneAndUpdate(
            { _id: loanId, returnedAt: null },
            { $set: { dueDate, dueDateUpdatedAt: new Date() } },
            { returnDocument: 'after' }
        )
    );
    if (!updated) throw ApiError.badRequest('This loan is already closed, so its due date cannot be changed.', 'LOAN_CLOSED');

    return serializeLoan(updated);
}

/**
 * GET /api/loans — members see their own loans, the librarian sees everyone's.
 * `status` = active | returned | overdue | all
 */
async function listLoans(user, { status = 'all', userId, bookId, page = 1, limit = 20 } = {}) {
    const filter = {};

    if (isLibrarian(user)) {
        if (userId) filter.userId = String(userId);
    } else {
        filter.userId = String(user.id);
    }

    if (bookId) filter.bookId = toObjectId(bookId, 'book id');

    const wanted = String(status || 'all').toLowerCase();
    if (wanted === 'active') {
        filter.returnedAt = null;
    } else if (wanted === 'returned') {
        filter.returnedAt = { $ne: null };
    } else if (wanted === 'overdue') {
        filter.returnedAt = null;
        filter.dueDate = { $lt: new Date() };
    } else if (wanted !== 'all') {
        throw ApiError.badRequest(`Unknown status "${status}". Use active, returned, overdue or all.`);
    }

    const now = new Date();
    const collection = loans();
    const total = await collection.countDocuments(filter);
    const docs = await collection
        .find(filter)
        .sort({ borrowedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray();

    return { items: docs.map((doc) => serializeLoan(doc, now)), total };
}

async function getLoan(user, rawLoanId) {
    const loan = await loans().findOne({ _id: toObjectId(rawLoanId, 'loan id') });
    if (!loan) throw ApiError.notFound('We could not find that loan record.', 'LOAN_NOT_FOUND');

    if (String(loan.userId) !== String(user.id) && !isLibrarian(user)) {
        throw ApiError.forbidden('You can only view your own loans.');
    }

    return serializeLoan(loan);
}

/** DELETE /api/loans/:id — librarian removes a loan record (active loans put the copy back first). */
async function deleteLoan(rawLoanId) {
    const loanId = toObjectId(rawLoanId, 'loan id');

    const loan = await loans().findOne({ _id: loanId });
    if (!loan) throw ApiError.notFound('We could not find that loan record.', 'LOAN_NOT_FOUND');

    if (!loan.returnedAt) await releaseCopy(loan.bookId);

    await loans().deleteOne({ _id: loanId });
    return serializeLoan(loan);
}

module.exports = {
    DAY_MS,
    LOAN_PERIOD_DAYS,
    serializeLoan,
    borrowBook,
    returnLoan,
    changeDueDate,
    listLoans,
    getLoan,
    deleteLoan
};
