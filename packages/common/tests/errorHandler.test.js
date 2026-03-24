import { jest, beforeAll, beforeEach, afterEach, test, expect } from '@jest/globals';

let createErrorArray;
let toErrorMessage;
let sanitizeText;
let handleError;

beforeAll(async () => {
  const module = await import('../errorHandler.js');
  createErrorArray = module.createErrorArray;
  toErrorMessage = module.toErrorMessage;
  sanitizeText = module.sanitizeText;
  handleError = module.handleError;
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('toErrorMessage extracts message from Error instance', () => {
  expect(toErrorMessage(new Error('boom'))).toBe('boom');
});

test('toErrorMessage returns string as-is', () => {
  expect(toErrorMessage('plain text')).toBe('plain text');
});

test('toErrorMessage serializes objects', () => {
  expect(toErrorMessage({ key: 'val' })).toBe('{"key":"val"}');
});

test('toErrorMessage falls back to String() for non-serializable', () => {
  const circular = {};
  circular.self = circular;
  expect(toErrorMessage(circular)).toBe('[object Object]');
});

test('sanitizeText redacts URLs', () => {
  const input = 'Error at https://example.com/secret/path';
  expect(sanitizeText(input)).toBe('Error at [REDACTED URL:example.com]');
});

test('sanitizeText redacts UUIDs', () => {
  const input = 'id=a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  expect(sanitizeText(input)).toBe('id=[REDACTED ID]');
});

test('sanitizeText returns non-string values unchanged', () => {
  expect(sanitizeText(null)).toBe(null);
  expect(sanitizeText(42)).toBe(42);
});

test('handleError does nothing for empty array', async () => {
  await handleError({
    errors: [],
    label: 'test',
    webhookUrl: 'https://discord.test/webhook',
    jobName: 'test:empty'
  });
  expect(console.log).not.toHaveBeenCalled();
});

test('handleError does nothing for null/undefined errors', async () => {
  await handleError({
    errors: null,
    label: 'test',
    webhookUrl: 'https://discord.test/webhook',
    jobName: 'test:null'
  });
  expect(console.log).not.toHaveBeenCalled();
});

test('handleError logs single error', async () => {
  await handleError({
    errors: new Error('test failure'),
    label: 'TestJob',
    webhookUrl: undefined,
    jobName: 'test:single'
  });

  expect(console.log).toHaveBeenCalledWith('[TestJob] Error:', 'test failure');
});

test('handleError logs only when webhookUrl is missing', async () => {
  await handleError({
    errors: new Error('no webhook'),
    label: 'TestJob',
    webhookUrl: undefined,
    jobName: 'test:noWebhook'
  });

  expect(console.log).toHaveBeenCalledWith('[TestJob] Error:', 'no webhook');
});

test('handleError handles array of errors', async () => {
  await handleError({
    errors: [new Error('err1'), new Error('err2')],
    label: 'TestJob',
    webhookUrl: undefined,
    jobName: 'test:array'
  });

  expect(console.log).toHaveBeenCalledWith('[TestJob] Error:', 'err1\nerr2');
});

test('handleError sanitizes URLs in error messages', async () => {
  await handleError({
    errors: new Error('Failed at https://secret.example.com/api/key'),
    label: 'TestJob',
    webhookUrl: undefined,
    jobName: 'test:sanitize'
  });

  expect(console.log).toHaveBeenCalledWith(
    '[TestJob] Error:',
    'Failed at [REDACTED URL:secret.example.com]'
  );
});

test('handleError filters out falsy values from array', async () => {
  await handleError({
    errors: [null, new Error('real error'), undefined],
    label: 'TestJob',
    webhookUrl: undefined,
    jobName: 'test:filter'
  });

  expect(console.log).toHaveBeenCalledWith('[TestJob] Error:', 'real error');
});

test('createErrorArray accumulates errors and returns them', () => {
  const errors = createErrorArray();
  errors.addError(new Error('err1'));
  errors.addError('err2');
  expect(errors.getErrors()).toHaveLength(2);
  expect(errors.getErrors()[0].message).toBe('err1');
  expect(errors.getErrors()[1]).toBe('err2');
});

test('createErrorArray starts with empty array', () => {
  const errors = createErrorArray();
  expect(errors.getErrors()).toEqual([]);
});

test('handleError handles string errors', async () => {
  await handleError({
    errors: 'something went wrong',
    label: 'TestJob',
    webhookUrl: undefined,
    jobName: 'test:string'
  });

  expect(console.log).toHaveBeenCalledWith('[TestJob] Error:', 'something went wrong');
});
