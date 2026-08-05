import assert from 'node:assert/strict'
import test from 'node:test'

import {
  errorMessage,
  isStaleAuthError,
  isStaleAuthErrorMessage,
} from './auth-retry.mjs'

test('isStaleAuthErrorMessage matches Cursor SDK auth strings', () => {
  assert.equal(
    isStaleAuthErrorMessage(
      'Authentication error. If you are logged in, try logging out and back in.',
    ),
    true,
  )
  assert.equal(isStaleAuthErrorMessage('ERROR_NOT_LOGGED_IN'), true)
  assert.equal(isStaleAuthErrorMessage('[unauthenticated] Error'), true)
  assert.equal(isStaleAuthErrorMessage('rate limit exceeded'), false)
  assert.equal(isStaleAuthErrorMessage(''), false)
})

test('isStaleAuthError handles AuthenticationError name', () => {
  assert.equal(isStaleAuthError({ name: 'AuthenticationError', message: 'x' }), true)
  assert.equal(isStaleAuthError(new Error('network timeout')), false)
})

test('errorMessage extracts message field', () => {
  assert.equal(errorMessage({ message: 'hello' }), 'hello')
  assert.equal(errorMessage('plain'), 'plain')
})
