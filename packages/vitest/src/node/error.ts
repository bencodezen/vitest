/* eslint-disable prefer-template */
import { existsSync, readFileSync } from 'node:fs'
import { normalize, relative } from 'pathe'
import c from 'picocolors'
import cliTruncate from 'cli-truncate'
import { stringify } from '@vitest/utils'
import type { ErrorWithDiff, ParsedStack } from '../types'
import { lineSplitRE, parseErrorStacktrace, positionToOffset } from '../utils/source-map'
import { F_POINTER } from '../utils/figures'
import { TypeCheckError } from '../typecheck/typechecker'
import { isPrimitive } from '../utils'
import type { Vitest } from './core'
import { divider } from './reporters/renderers/utils'
import type { Logger } from './logger'

interface PrintErrorOptions {
  type?: string
  fullStack?: boolean
  showCodeFrame?: boolean
}

export async function printError(error: unknown, ctx: Vitest, options: PrintErrorOptions = {}) {
  const { showCodeFrame = true, fullStack = false, type } = options
  let e = error as ErrorWithDiff

  if (isPrimitive(e)) {
    e = {
      message: String(error).split(/\n/g)[0],
      stack: String(error),
    } as any
  }

  if (!e) {
    const error = new Error('unknown error')
    e = {
      message: e ?? error.message,
      stack: error.stack,
    } as any
  }

  // Error may have occured even before the configuration was resolved
  if (!ctx.config)
    return printErrorMessage(e, ctx.logger)

  const stacks = parseErrorStacktrace(e, fullStack ? [] : undefined)

  const nearest = error instanceof TypeCheckError
    ? error.stacks[0]
    : stacks.find(stack =>
      ctx.getModuleProjects(stack.file).length
      && existsSync(stack.file),
    )

  const errorProperties = getErrorProperties(e)

  if (type)
    printErrorType(type, ctx)
  printErrorMessage(e, ctx.logger)

  // if the error provide the frame
  if (e.frame) {
    ctx.logger.error(c.yellow(e.frame))
  }
  else {
    printStack(ctx, stacks, nearest, errorProperties, (s) => {
      if (showCodeFrame && s === nearest && nearest) {
        const sourceCode = readFileSync(nearest.file, 'utf-8')
        ctx.logger.error(c.yellow(generateCodeFrame(sourceCode, 4, s.line, s.column)))
      }
    })
  }

  const testPath = (e as any).VITEST_TEST_PATH
  const testName = (e as any).VITEST_TEST_NAME
  const afterEnvTeardown = (e as any).VITEST_AFTER_ENV_TEARDOWN
  // testName has testPath inside
  if (testPath)
    ctx.logger.error(c.red(`This error originated in "${c.bold(testPath)}" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.`))
  if (testName) {
    ctx.logger.error(c.red(`The latest test that might've caused the error is "${c.bold(testName)}". It might mean one of the following:`
    + '\n- The error was thrown, while Vitest was running this test.'
    + '\n- This was the last recorded test before the error was thrown, if error originated after test finished its execution.'))
  }
  if (afterEnvTeardown) {
    ctx.logger.error(c.red('This error was caught after test environment was torn down. Make sure to cancel any running tasks before test finishes:'
    + '\n- cancel timeouts using clearTimeout and clearInterval'
    + '\n- wait for promises to resolve using the await keyword'))
  }

  if (typeof e.cause === 'object' && e.cause && 'name' in e.cause) {
    (e.cause as any).name = `Caused by: ${(e.cause as any).name}`
    await printError(e.cause, ctx, { fullStack, showCodeFrame: false })
  }

  handleImportOutsideModuleError(e.stack || e.stackStr || '', ctx)

  // E.g. AssertionError from assert does not set showDiff but has both actual and expected properties
  if (e.diff)
    displayDiff(e.diff, ctx.logger.console)
}

function printErrorType(type: string, ctx: Vitest) {
  ctx.logger.error(`\n${c.red(divider(c.bold(c.inverse(` ${type} `))))}`)
}

const skipErrorProperties = new Set([
  'nameStr',
  'stack',
  'cause',
  'stacks',
  'stackStr',
  'type',
  'showDiff',
  'diff',
  'actual',
  'expected',
  'VITEST_TEST_NAME',
  'VITEST_TEST_PATH',
  'VITEST_AFTER_ENV_TEARDOWN',
  ...Object.getOwnPropertyNames(Error.prototype),
  ...Object.getOwnPropertyNames(Object.prototype),
])

function getErrorProperties(e: ErrorWithDiff) {
  const errorObject = Object.create(null)
  if (e.name === 'AssertionError')
    return errorObject

  for (const key of Object.getOwnPropertyNames(e)) {
    if (!skipErrorProperties.has(key))
      errorObject[key] = e[key as keyof ErrorWithDiff]
  }

  return errorObject
}

const esmErrors = [
  'Cannot use import statement outside a module',
  'Unexpected token \'export\'',
]

function handleImportOutsideModuleError(stack: string, ctx: Vitest) {
  if (!esmErrors.some(e => stack.includes(e)))
    return

  const path = normalize(stack.split('\n')[0].trim())
  let name = path.split('/node_modules/').pop() || ''
  if (name?.startsWith('@'))
    name = name.split('/').slice(0, 2).join('/')
  else
    name = name.split('/')[0]

  ctx.logger.error(c.yellow(
    `Module ${path} seems to be an ES Module but shipped in a CommonJS package. `
+ `You might want to create an issue to the package ${c.bold(`"${name}"`)} asking `
+ 'them to ship the file in .mjs extension or add "type": "module" in their package.json.'
+ '\n\n'
+ 'As a temporary workaround you can try to inline the package by updating your config:'
+ '\n\n'
+ c.gray(c.dim('// vitest.config.js'))
+ '\n'
+ c.green(`export default {
  test: {
    deps: {
      inline: [
        ${c.yellow(c.bold(`"${name}"`))}
      ]
    }
  }
}\n`)))
}

export function displayDiff(diff: string, console: Console) {
  console.error(diff)
}

function printErrorMessage(error: ErrorWithDiff, logger: Logger) {
  const errorName = error.name || error.nameStr || 'Unknown Error'
  logger.error(c.red(`${c.bold(errorName)}: ${error.message}`))
}

function printStack(
  ctx: Vitest,
  stack: ParsedStack[],
  highlight: ParsedStack | undefined,
  errorProperties: Record<string, unknown>,
  onStack?: ((stack: ParsedStack) => void),
) {
  const logger = ctx.logger

  for (const frame of stack) {
    const color = frame === highlight ? c.yellow : c.gray
    const path = relative(ctx.config.root, frame.file)

    logger.error(color(` ${c.dim(F_POINTER)} ${[frame.method, c.dim(`${path}:${frame.line}:${frame.column}`)].filter(Boolean).join(' ')}`))
    onStack?.(frame)
  }
  if (stack.length)
    logger.error()
  const hasProperties = Object.keys(errorProperties).length > 0
  if (hasProperties) {
    logger.error(c.red(c.dim(divider())))
    const propertiesString = stringify(errorProperties, 10, { printBasicPrototype: false })
    logger.error(c.red(c.bold('Serialized Error:')), c.gray(propertiesString))
  }
}

export function generateCodeFrame(
  source: string,
  indent = 0,
  lineNumber: number,
  columnNumber: number,
  range = 2,
): string {
  const start = positionToOffset(source, lineNumber, columnNumber)
  const end = start
  const lines = source.split(lineSplitRE)
  let count = 0
  let res: string[] = []

  const columns = process.stdout?.columns || 80

  function lineNo(no: number | string = '') {
    return c.gray(`${String(no).padStart(3, ' ')}| `)
  }

  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length + 1
    if (count >= start) {
      for (let j = i - range; j <= i + range || end > count; j++) {
        if (j < 0 || j >= lines.length)
          continue

        const lineLength = lines[j].length

        // to long, maybe it's a minified file, skip for codeframe
        if (lineLength > 200)
          return ''

        res.push(lineNo(j + 1) + cliTruncate(lines[j].replace(/\t/g, ' '), columns - 5 - indent))

        if (j === i) {
          // push underline
          const pad = start - (count - lineLength)
          const length = Math.max(1, end > count ? lineLength - pad : end - start)
          res.push(lineNo() + ' '.repeat(pad) + c.red('^'.repeat(length)))
        }
        else if (j > i) {
          if (end > count) {
            const length = Math.max(1, Math.min(end - count, lineLength))
            res.push(lineNo() + c.red('^'.repeat(length)))
          }
          count += lineLength + 1
        }
      }
      break
    }
  }

  if (indent)
    res = res.map(line => ' '.repeat(indent) + line)

  return res.join('\n')
}
