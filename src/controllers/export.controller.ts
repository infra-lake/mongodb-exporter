import { CountDocumentsOptions, Document, Filter, FindOptions, ListCollectionsOptions, ListDatabasesOptions, ObjectId, Sort } from 'mongodb'
import { BadRequestError } from '../exceptions/badrequest.error'
import { AuthHelper } from '../helpers/auth.helper'
import { MongoDBHelper } from '../helpers/mongodb.helper'
import { ObjectHelper } from '../helpers/object.helper'
import { QueryStringHelper } from '../helpers/querystring.helper'
import { Stamps, StampsHelper } from '../helpers/stamps.helper'
import { StreamHelper } from '../helpers/stream.helper'
import { Window, WindowHelper } from '../helpers/window.helper'
import { Logger, Regex, RegexController, Request, Response } from '../regex'

export class ExportController implements RegexController {

    static path = '^/export'

    public async get(request: Request, response: Response) {

        try {

            if (!AuthHelper.validate(request, response)) {
                return
            }

            const input = _input(request)
            const filter = _filter(input)
            const metadata = await _metadata(input, filter)

            let count = 0

            _find(input, filter)
                .on('resume', () => {
                    response.setHeader('Content-Type', 'application/json')
                    response.write(`{ "metadata": ${metadata}, "results": [`)
                    response.setStatusCode(200)
                })
                .on('data', chunk => {

                    if (++count > 1) {
                        response.write(',')
                    }

                    const output = _output(input, chunk)
                    response.write(JSON.stringify(output))

                })
                .on('end', () => {
                    response.write('] }')
                    response.end()
                })
                .on('error', (error) => {
                    console.error('error:', error)
                    response.setStatusCode(500)
                    response.end()
                })

        } catch (error) {

            const logger = Logger.from(request)

            logger.error('error:', error)

            const bad = error instanceof BadRequestError

            response.setStatusCode(bad ? 400 : 500)
            if (bad) {
                response.write(error.message)
            }

            response.end()

        }

    }

}

type Path = {
    database?: string
    collection?: string
}
type SeachIndexMode = 'offset' | 'page'
type SearchIndex = {
    mode: SeachIndexMode,
    value: number
}
type QueryParameters<T extends Document> = {
    projection: T
    filter: Filter<T>
    sort: Sort
    limit: number
    index: SearchIndex
}
type ExporterControllerInput<T extends Document> = {
    path: Path
    parameters: QueryParameters<T>
    stamps: Stamps
    window: Window
}
function _input<T extends Document>(request: Request): ExporterControllerInput<T> {

    const { searchParams, pathname } = request.getURL()
    const [_, database, collection, hash] = pathname.split('/').filter(value => value)

    const parameters =
        ObjectHelper.has(hash)
            ? QueryStringHelper.parse(Buffer.from(hash, 'base64').toString('utf-8'))
            : QueryStringHelper.parse(searchParams)

    const stamps = StampsHelper.extract(parameters)
    const window = WindowHelper.extract(parameters)

    return { path: { database, collection }, parameters, stamps, window }

}

type ExportFilter<T extends Document> = {
    value: Filter<T>,
    options: ListDatabasesOptions | ListCollectionsOptions | CountDocumentsOptions | FindOptions<T>
}
function _filter<T extends Document>({ parameters, stamps, window }: ExporterControllerInput<T>): ExportFilter<T> {

    const { projection, filter = {}, sort, limit, index } = parameters
    const options = { projection, sort, limit, skip: _skip({ limit, index }) }

    if (ObjectHelper.has(window.begin)) {
        (filter as any)['$expr'] = (filter as any)['$expr'] ?? {} as any
        (filter as any)['$expr']['$and'] = (filter as any)['$expr']['$and'] ?? [] as any
        (filter as any)['$expr']['$and'].push({ $gt: [{ $ifNull: [`$${stamps.update}`, `$${stamps.insert}`, { $convert: { input: `$${stamps.id}`, to: "date" } }] }, window.begin] })
    }

    if (ObjectHelper.has(window.end)) {
        (filter as any)['$expr'] = (filter as any)['$expr'] ?? {} as any
        (filter as any)['$expr']['$and'] = (filter as any)['$expr']['$and'] ?? [] as any
        (filter as any)['$expr']['$and'].push({ $lte: [{ $ifNull: [`$${stamps.update}`, `$${stamps.insert}`, { $convert: { input: `$${stamps.id}`, to: "date" } }] }, window.end] })
    }

    const value = (Object.keys(filter).length > 0 ? filter : undefined) as any

    return { value, options }

}

type SkipInput = { limit: number, index: SearchIndex }
function _skip({ limit, index }: SkipInput) {
    const { mode, value } = index
    const _value = value < 0 ? 0 : value
    const result = mode === 'offset' ? _value : limit * _value
    return result
}

async function _metadata<T extends Document>(input: ExporterControllerInput<T>, filter: ExportFilter<T>) {

    const count = await _count(input, filter)

    const index =
        input.parameters.index.mode === 'offset'
            ? input.parameters.index.value / input.parameters.limit
            : input.parameters.index.value

    const result: any = { index, count }

    if (ObjectHelper.has(input.path.database) && ObjectHelper.has(input.path.collection)) {
        result.previous = await _previous(input, filter, count)
        result.next = await _next(input, filter, count)
    }

    return JSON.stringify(result)

}

function _previous<T extends Document>(input: ExporterControllerInput<T>, filter: ExportFilter<T>, count: number) {

    const { parameters } = input
    const { projection, filter: _filter, sort, limit, index } = parameters

    const value =
        count < 0
            ? false
            : ((filter?.options as any)?.skip ?? 0) > 0

    const token =
        index.mode === 'offset'
            ? value
                ? _token({
                    projection,
                    filter: _filter,
                    sort,
                    limit,
                    index: {
                        mode: index.mode,
                        value: (index.value - limit) < 0 ? 0 : (index.value - limit)
                    }
                })
                : null
            : value
                ? _token({
                    projection,
                    filter: _filter,
                    sort,
                    limit,
                    index: {
                        mode: index.mode,
                        value: (index.value - 1) < 0 ? 0 : (index.value - 1)
                    }
                })
                : null

    return { value, token }

}

async function _next<T extends Document>(input: ExporterControllerInput<T>, filter: ExportFilter<T>, count: number) {

    const { parameters } = input
    const { projection, filter: _filter, sort, limit, index } = parameters

    const value =
        count < limit
            ? false
            : await _count(input, { ...filter, options: { ...filter.options, limit: 1, skip: limit + ((filter?.options as any)?.skip ?? 0) } }) > 0

    const token =
        index.mode === 'offset'
            ? value ? _token({ projection, filter: _filter, sort, limit, index: { mode: index.mode, value: index.value + limit } }) : null
            : value ? _token({ projection, filter: _filter, sort, limit, index: { mode: index.mode, value: index.value + 1 } }) : null

    return { value, token }

}

function _token<T extends Document>(parameters: QueryParameters<T>): string {

    (parameters as any).mode = parameters.index.mode
    if (parameters.index.mode === 'offset') {
        (parameters as any).offset = parameters.index.value
    } else {
        (parameters as any).page = parameters.index.value
    }
    delete (parameters as any).index

    return QueryStringHelper.stringify(parameters)

}

async function _count<T extends Document>({ path }: ExporterControllerInput<T>, filter: ExportFilter<T>): Promise<number> {

    const { database, collection } = path

    if (!ObjectHelper.has(database) && !ObjectHelper.has(collection)) {
        const mongodb = Regex.inject(MongoDBHelper)
        const databases = await mongodb.databases()
        return databases.length
    }

    if (!ObjectHelper.has(collection)) {
        const mongodb = Regex.inject(MongoDBHelper)
        const collections = await mongodb.collections(database as string)
        return collections.length
    }

    if (ObjectHelper.has(database) && ObjectHelper.has(collection)) {
        const mongodb = Regex.inject(MongoDBHelper)
        const { value, options } = filter
        const result = await mongodb.count(database as string, collection as string, value as any, options)
        return result
    }

    throw new Error(`database of collection ${collection} must be informed!`)

}

function _find<T extends Document>({ path }: ExporterControllerInput<T>, filter: ExportFilter<T>) {

    const { database, collection } = path

    if (!ObjectHelper.has(database) && !ObjectHelper.has(collection)) {
        const mongodb = Regex.inject(MongoDBHelper)
        return StreamHelper.create(mongodb.databases(), {
            transform: (stream, databases) =>
                databases.forEach(({ name }) => stream.push({ name }))
        })
    }

    if (!ObjectHelper.has(collection)) {
        const mongodb = Regex.inject(MongoDBHelper)
        return StreamHelper.create(mongodb.collections(database as string), {
            transform: (stream, collections) =>
                collections.forEach(({ dbName: database, collectionName: name }) => stream.push({ database, name }))
        })
    }

    if (ObjectHelper.has(database) && ObjectHelper.has(collection)) {
        const { value, options } = filter
        const mongodb = Regex.inject(MongoDBHelper)
        return mongodb.find(database as string, collection as string, value as any, options)
    }

    throw new Error(`database of collection ${collection} must be informed!`)

}

function _output<T extends Document>({ stamps }: ExporterControllerInput<T>, chunk: any) {
    const { insert, update, id } = stamps
    chunk[insert] = chunk[insert] ?? new ObjectId(chunk[id]).getTimestamp()
    chunk[update] = chunk[update] ?? chunk[insert]
    return chunk
}