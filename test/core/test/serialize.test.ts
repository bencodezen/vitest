// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { serializeError } from '@vitest/runner/utils'

describe('error serialize', () => {
  it('works', () => {
    expect(serializeError(undefined)).toEqual(undefined)
    expect(serializeError(null)).toEqual(null)
    expect(serializeError('hi')).toEqual('hi')

    expect(serializeError({
      foo: 'hi',
      promise: new Promise(() => {}),
      fn: () => {},
      null: null,
      symbol: Symbol('hi'),
      nested: {
        false: false,
        class: class {},
      },
      // Intentionally test with a sparse array to verify it remains sparse during serialization.
      // eslint-disable-next-line no-sparse-arrays
      array: [1,, 3],
    })).toMatchSnapshot()
  })

  it('Should skip circular references to prevent hit the call stack limit', () => {
    const error: Record<string, any> = {
      toString: () => {
        return 'ops something went wrong'
      },
    }
    error.whatever = error
    error.whateverArray = [error, error]
    error.whateverArrayClone = error.whateverArray

    expect(serializeError(error)).toMatchSnapshot()
  })

  it('Should handle object with getter/setter correctly', () => {
    const user = {
      name: 'John',
      surname: 'Smith',

      get fullName() {
        return `${this.name} ${this.surname}`
      },
      set fullName(value) {
        [this.name, this.surname] = value.split(' ')
      },
    }

    expect(serializeError(user)).toEqual({
      name: 'John',
      surname: 'Smith',
      fullName: 'John Smith',
    })
  })

  it('Should copy the full prototype chain including non-enumerable properties', () => {
    const user = {
      name: 'John',
      surname: 'Smith',
    }
    Object.setPrototypeOf(user, {
      name: 'Mr',
      base: true,
    })

    Object.defineProperty(user, 'fullName', { enumerable: false, value: 'John Smith' })

    const serialized = serializeError(user)
    expect(serialized).not.toBe(user)
    expect(serialized).toEqual({
      name: 'John',
      surname: 'Smith',
      fullName: 'John Smith',
      base: true,
    })
  })

  it('Should not retain the constructor of an object', () => {
    // https://github.com/vitest-dev/vitest/issues/374
    // Objects with `Error` constructors appear to cause problems during worker communication using
    // `MessagePort`, so the serialized error object should have been recreated as plain object.
    const error = new Error('test')

    const serialized = serializeError(error)
    expect(Object.getPrototypeOf(serialized)).toBe(null)
    expect(serialized).toEqual({
      constructor: 'Function<Error>',
      name: 'Error',
      message: 'test',
      stack: expect.any(String),
      toString: 'Function<toString>',
    })
  })

  it('Should not fail on errored getters/setters', () => {
    const error = new Error('test')
    Object.defineProperty(error, 'unserializable', {
      get() {
        throw new Error('I am unserializable')
      },
      set() {
        throw new Error('I am unserializable')
      },
    })
    Object.defineProperty(error, 'array', {
      value: [{
        get name() {
          throw new Error('name cannot be accessed')
        },
      }],
    })
    expect(serializeError(error)).toEqual({
      array: [
        {
          name: '<unserializable>: name cannot be accessed',
        },
      ],
      constructor: 'Function<Error>',
      message: 'test',
      name: 'Error',
      stack: expect.stringContaining('Error: test'),
      toString: 'Function<toString>',
      unserializable: '<unserializable>: I am unserializable',
    })
  })

  it('can serialize DOMException', () => {
    const err = new DOMException('You failed', 'InvalidStateError')
    expect(serializeError(err)).toMatchObject({
      NETWORK_ERR: 19,
      name: 'InvalidStateError',
      message: 'You failed',
      stack: expect.stringContaining('InvalidStateError: You failed'),
    })
  })

  it('correctly serialized immutables', () => {
    const immutableList = {
      '@@__IMMUTABLE_ITERABLE__@@': true,
      toJSON() {
        return ['foo']
      },
    }

    const immutableRecord = {
      '@@__IMMUTABLE_RECORD__@@': true,
      toJSON() {
        return { foo: 'bar' }
      },
    }

    const error = new Error('test')
    Object.assign(error, {
      immutableList,
      immutableRecord,
    })

    expect(serializeError(error)).toMatchObject({
      stack: expect.stringContaining('Error: test'),
      immutableList: ['foo'],
      immutableRecord: { foo: 'bar' },
      name: 'Error',
      message: 'test',
    })
  })
})
