'use strict'

const util = require('util')

const contentPath = require('../lib/content/path')
const index = require('../lib/entry-index')
const fs = require('fs')
const path = require('path')
const Tacks = require('tacks')
const requireInject = require('require-inject')
const { test } = require('tap')
const testDir = require('./util/test-dir')(__filename)
const ssri = require('ssri')

const CacheContent = require('./util/cache-content')

const CACHE = path.join(testDir, 'cache')
const CONTENT = Buffer.from('foobarbaz', 'utf8')
const KEY = 'my-test-key'
const INTEGRITY = ssri.fromData(CONTENT)
const METADATA = { foo: 'bar' }
const BUCKET = index.bucketPath(CACHE, KEY)

const verify = require('..').verify

const mkdir = util.promisify(fs.mkdir)
const readFile = util.promisify(fs.readFile)
const truncate = util.promisify(fs.truncate)
const stat = util.promisify(fs.stat)
const appendFile = util.promisify(fs.appendFile)
const writeFile = util.promisify(fs.writeFile)

// defines reusable errors
const genericError = new Error('ERR')
genericError.code = 'ERR'

// helpers
const getVerify = (opts) => requireInject('../lib/verify', opts)

function mockCache () {
  const fixture = new Tacks(
    CacheContent({
      [INTEGRITY]: CONTENT,
    })
  )
  fixture.create(CACHE)
  return mkdir(path.join(CACHE, 'tmp')).then(() => {
    return index.insert(CACHE, KEY, INTEGRITY, {
      metadata: METADATA,
    })
  })
}

test('removes corrupted index entries from buckets', (t) => {
  return mockCache().then(() => {
    return readFile(BUCKET, 'utf8').then((BUCKETDATA) => {
      // traaaaash
      return appendFile(BUCKET, '\n234uhhh')
        .then(() => {
          return verify(CACHE)
        })
        .then((stats) => {
          t.equal(
            stats.missingContent,
            0,
            'content valid because of good entry'
          )
          t.equal(stats.totalEntries, 1, 'only one entry counted')
          return readFile(BUCKET, 'utf8')
        })
        .then((bucketData) => {
          const bucketEntry = JSON.parse(bucketData.split('\t')[1])
          const targetEntry = JSON.parse(BUCKETDATA.split('\t')[1])
          targetEntry.time = bucketEntry.time // different timestamps
          t.same(
            bucketEntry,
            targetEntry,
            'bucket only contains good entry'
          )
        })
    })
  })
})

test('removes shadowed index entries from buckets', (t) => {
  return mockCache().then(() => {
    return index
      .insert(CACHE, KEY, INTEGRITY, {
        metadata: 'meh',
      })
      .then((newEntry) => {
        return verify(CACHE)
          .then((stats) => {
            t.equal(
              stats.missingContent,
              0,
              'content valid because of good entry'
            )
            t.equal(stats.totalEntries, 1, 'only one entry counted')
            return readFile(BUCKET, 'utf8')
          })
          .then((bucketData) => {
            const stringified = JSON.stringify({
              key: newEntry.key,
              integrity: newEntry.integrity.toString(),
              time: +bucketData.match(/"time":([0-9]+)/)[1],
              metadata: newEntry.metadata,
            })
            t.equal(
              bucketData,
              `\n${index.hashEntry(stringified)}\t${stringified}`,
              'only the most recent entry is still in the bucket'
            )
          })
      })
  })
})

test('accepts function for custom user filtering of index entries', (t) => {
  const KEY2 = KEY + 'aaa'
  const KEY3 = KEY + 'bbb'
  return mockCache()
    .then(() => {
      return Promise.all([
        index.insert(CACHE, KEY2, INTEGRITY, {
          metadata: 'haayyyy',
        }),
        index.insert(CACHE, KEY3, INTEGRITY, {
          metadata: 'haayyyy again',
        }),
      ]).then(([entryA, entryB]) => ({
        [entryA.key]: entryA,
        [entryB.key]: entryB,
      }))
    })
    .then((newEntries) => {
      return verify(CACHE, {
        filter (entry) {
          return entry.key.length === KEY2.length
        },
      })
        .then((stats) => {
          t.same(
            {
              verifiedContent: stats.verifiedContent,
              rejectedEntries: stats.rejectedEntries,
              totalEntries: stats.totalEntries,
            },
            {
              verifiedContent: 1,
              rejectedEntries: 1,
              totalEntries: 2,
            },
            'reported relevant changes'
          )
          return index.ls(CACHE)
        })
        .then((entries) => {
          entries[KEY2].time = newEntries[KEY2].time
          entries[KEY3].time = newEntries[KEY3].time
          t.same(entries, newEntries, 'original entry not included')
        })
    })
})

test('removes corrupted content', (t) => {
  const cpath = contentPath(CACHE, INTEGRITY)
  return mockCache()
    .then(() => {
      return truncate(cpath, CONTENT.length - 1)
    })
    .then(() => {
      return verify(CACHE)
    })
    .then((stats) => {
      delete stats.startTime
      delete stats.runTime
      delete stats.endTime
      t.same(
        stats,
        {
          verifiedContent: 0,
          reclaimedCount: 1,
          reclaimedSize: CONTENT.length - 1,
          badContentCount: 1,
          keptSize: 0,
          missingContent: 1,
          rejectedEntries: 1,
          totalEntries: 0,
        },
        'reported correct collection counts'
      )
      return stat(cpath)
        .then(() => {
          throw new Error('expected a failure')
        })
        .catch((err) => {
          if (err.code === 'ENOENT') {
            t.match(err.message, /no such file/, 'content no longer in cache')
            return
          }
          throw err
        })
    })
})

test('removes content not referenced by any entries', (t) => {
  const fixture = new Tacks(
    CacheContent({
      [INTEGRITY]: CONTENT,
    })
  )
  fixture.create(CACHE)
  return verify(CACHE).then((stats) => {
    delete stats.startTime
    delete stats.runTime
    delete stats.endTime
    t.same(
      stats,
      {
        verifiedContent: 0,
        reclaimedCount: 1,
        reclaimedSize: CONTENT.length,
        badContentCount: 0,
        keptSize: 0,
        missingContent: 0,
        rejectedEntries: 0,
        totalEntries: 0,
      },
      'reported correct collection counts'
    )
  })
})

test('cleans up contents of tmp dir', (t) => {
  const tmpFile = path.join(CACHE, 'tmp', 'x')
  const misc = path.join(CACHE, 'y')
  return mockCache()
    .then(() => {
      return Promise.all([writeFile(tmpFile, ''), writeFile(misc, '')]).then(
        () => verify(CACHE)
      )
    })
    .then(() => {
      return Promise.all([
        stat(tmpFile).catch((err) => {
          if (err.code === 'ENOENT')
            return err

          throw err
        }),
        stat(misc),
      ]).then(([err, stat]) => {
        t.equal(err.code, 'ENOENT', 'tmp file was blown away')
        t.ok(stat, 'misc file was not touched')
      })
    })
})

test('writes a file with last verification time', (t) => {
  return verify(CACHE).then(() => {
    return Promise.all([
      verify.lastRun(CACHE),
      readFile(path.join(CACHE, '_lastverified'), 'utf8').then((data) => {
        return new Date(parseInt(data))
      }),
    ]).then(([fromLastRun, fromFile]) => {
      t.equal(+fromLastRun, +fromFile, 'last verified was writen')
    })
  })
})

test('fixes permissions and users on cache contents')

test('missing file error when validating cache content', (t) => {
  const missingFileError = new Error('ENOENT')
  missingFileError.code = 'ENOENT'
  const mockVerify = getVerify({
    fs: Object.assign({}, fs, {
      stat: (path, cb) => {
        cb(missingFileError)
      },
    }),
  })

  t.plan(1)
  mockCache().then(() => {
    t.resolveMatch(
      mockVerify(CACHE),
      {
        verifiedContent: 0,
        rejectedEntries: 1,
        totalEntries: 0,
      },
      'should reject entry'
    )
  })
})

test('unknown error when validating content', (t) => {
  const mockVerify = getVerify({
    fs: Object.assign({}, fs, {
      stat: (path, cb) => {
        cb(genericError)
      },
    }),
  })

  t.plan(1)
  mockCache().then(() => {
    t.rejects(
      mockVerify(CACHE),
      genericError,
      'should throw any unknown errors'
    )
  })
})

test('unknown error when checking sri stream', (t) => {
  const mockVerify = getVerify({
    ssri: Object.assign({}, ssri, {
      checkStream: () => Promise.reject(genericError),
    }),
  })

  t.plan(1)
  mockCache().then(() => {
    t.rejects(
      mockVerify(CACHE),
      genericError,
      'should throw any unknown errors'
    )
  })
})

test('unknown error when rebuilding bucket', (t) => {
  // rebuild bucket uses stat after content-validation
  // shouldFail controls the right time to mock the error
  let shouldFail = false
  const mockVerify = getVerify({
    fs: Object.assign({}, fs, {
      stat: (path, cb) => {
        if (shouldFail)
          return cb(genericError)

        fs.stat(path, cb)
        shouldFail = true
      },
    }),
  })

  t.plan(1)
  mockCache().then(() => {
    t.rejects(
      mockVerify(CACHE),
      genericError,
      'should throw any unknown errors'
    )
  })
})

test('re-builds the index with the size parameter', (t) => {
  const KEY2 = KEY + 'aaa'
  const KEY3 = KEY + 'bbb'
  return mockCache()
    .then(() => {
      return Promise.all([
        index.insert(CACHE, KEY2, INTEGRITY, {
          metadata: 'haayyyy',
          size: 20,
        }),
        index.insert(CACHE, KEY3, INTEGRITY, {
          metadata: 'haayyyy again',
          size: 30,
        }),
      ])
    })
    .then(() => {
      return index.ls(CACHE).then((newEntries) => {
        return verify(CACHE)
          .then((stats) => {
            t.same(
              {
                verifiedContent: stats.verifiedContent,
                rejectedEntries: stats.rejectedEntries,
                totalEntries: stats.totalEntries,
              },
              {
                verifiedContent: 1,
                rejectedEntries: 0,
                totalEntries: 3,
              },
              'reported relevant changes'
            )
            return index.ls(CACHE)
          })
          .then((entries) => {
            entries[KEY].time = newEntries[KEY].time
            entries[KEY2].time = newEntries[KEY2].time
            entries[KEY3].time = newEntries[KEY3].time
            t.same(
              entries,
              newEntries,
              'original index entries not preserved'
            )
          })
      })
    })
})

test('hash collisions', (t) => {
  const mockVerify = getVerify({
    '../lib/entry-index': Object.assign({}, index, {
      hashKey: () => 'aaa',
    }),
  })

  t.plan(1)
  mockCache()
    .then(() =>
      index.insert(CACHE, 'foo', INTEGRITY, {
        metadata: 'foo',
      }))
    .then(() => mockVerify(CACHE))
    .then((stats) => {
      t.same(
        {
          verifiedContent: stats.verifiedContent,
          rejectedEntries: stats.rejectedEntries,
          totalEntries: stats.totalEntries,
        },
        {
          verifiedContent: 1,
          rejectedEntries: 0,
          totalEntries: 2,
        },
        'should resolve with no errors'
      )
    })
})

test('hash collisions excluded', (t) => {
  const mockVerify = getVerify({
    '../lib/entry-index': Object.assign({}, index, {
      hashKey: () => 'aaa',
    }),
  })

  t.plan(1)
  mockCache()
    .then(() =>
      index.insert(CACHE, 'foo', INTEGRITY, {
        metadata: 'foo',
      }))
    .then(() => mockVerify(CACHE, { filter: () => null }))
    .then((stats) => {
      t.same(
        {
          verifiedContent: stats.verifiedContent,
          rejectedEntries: stats.rejectedEntries,
          totalEntries: stats.totalEntries,
        },
        {
          verifiedContent: 0,
          rejectedEntries: 2,
          totalEntries: 0,
        },
        'should resolve while also excluding filtered out entries'
      )
    })
})
