'use strict';

const express = require('express');
const ApiError = require('../../lib/apiError');
const bookRoutes = require('./books');
const loanRoutes = require('./loans');

const router = express.Router();

/**
 * JSON body parsing lives here as well as in server.js so that a malformed
 * body gets a JSON error answer instead of Express' default HTML page.
 * express.json() skips parsing when the body was already parsed upstream.
 */
router.use(express.json({ limit: '100kb' }));

// API answers are live data; never let a browser or proxy cache them.
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

/** GET /api — a tiny index so the marker can discover the endpoints. */
router.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'COMP3810SEF Group 1 — Library REST API',
        endpoints: {
            books: '/api/books',
            loans: '/api/loans'
        }
    });
});

router.use('/books', bookRoutes);
router.use('/loans', loanRoutes);

/** Unknown /api/... path. */
router.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'That API endpoint does not exist.',
        code: 'ENDPOINT_NOT_FOUND'
    });
});

/**
 * One JSON error handler for the whole API.
 * Express 5 forwards rejected promises from async handlers here automatically.
 */
router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error instanceof ApiError) {
        return res.status(error.status).json({
            success: false,
            error: error.message,
            code: error.code,
            ...(error.details ? { details: error.details } : {})
        });
    }

    if (error && error.type === 'entity.parse.failed') {
        return res.status(400).json({
            success: false,
            error: 'The request body is not valid JSON.',
            code: 'INVALID_JSON'
        });
    }

    console.error('❌ API error:', error);
    res.status(500).json({
        success: false,
        error: 'Something went wrong on our side. Please try again.',
        code: 'INTERNAL_ERROR'
    });
});

module.exports = router;
