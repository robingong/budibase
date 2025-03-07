const { processString } = require("@budibase/string-templates")
const CouchDB = require("../../db")
const { generateQueryID, getQueryParams } = require("../../db/utils")
const { integrations } = require("../../integrations")
const { BaseQueryVerbs } = require("../../constants")
const env = require("../../environment")
const ScriptRunner = require("../../utilities/scriptRunner")

// simple function to append "readable" to all read queries
function enrichQueries(input) {
  const wasArray = Array.isArray(input)
  const queries = wasArray ? input : [input]
  for (let query of queries) {
    if (query.queryVerb === BaseQueryVerbs.READ) {
      query.readable = true
    }
  }
  return wasArray ? queries : queries[0]
}

function formatResponse(resp) {
  if (typeof resp === "string") {
    try {
      resp = JSON.parse(resp)
    } catch (err) {
      resp = { response: resp }
    }
  }
  return resp
}

async function runAndTransform(
  integration,
  queryVerb,
  enrichedQuery,
  transformer
) {
  let rows = formatResponse(await integration[queryVerb](enrichedQuery))

  // transform as required
  if (transformer) {
    const runner = new ScriptRunner(transformer, { data: rows })
    rows = runner.execute()
  }

  // needs to an array for next step
  if (!Array.isArray(rows)) {
    rows = [rows]
  }

  // map into JSON if just raw primitive here
  if (rows.find(row => typeof row !== "object")) {
    rows = rows.map(value => ({ value }))
  }

  // get all the potential fields in the schema
  let keys = rows.flatMap(Object.keys)

  return { rows, keys }
}

exports.fetch = async function (ctx) {
  const db = new CouchDB(ctx.appId)

  const body = await db.allDocs(
    getQueryParams(null, {
      include_docs: true,
    })
  )
  ctx.body = enrichQueries(body.rows.map(row => row.doc))
}

exports.save = async function (ctx) {
  const db = new CouchDB(ctx.appId)
  const query = ctx.request.body

  if (!query._id) {
    query._id = generateQueryID(query.datasourceId)
  }

  const response = await db.put(query)
  query._rev = response.rev

  ctx.body = query
  ctx.message = `Query ${query.name} saved successfully.`
}

async function enrichQueryFields(fields, parameters = {}) {
  const enrichedQuery = {}

  // enrich the fields with dynamic parameters
  for (let key of Object.keys(fields)) {
    if (fields[key] == null) {
      continue
    }
    if (typeof fields[key] === "object") {
      // enrich nested fields object
      enrichedQuery[key] = await enrichQueryFields(fields[key], parameters)
    } else if (typeof fields[key] === "string") {
      // enrich string value as normal
      enrichedQuery[key] = await processString(fields[key], parameters, {
        noHelpers: true,
      })
    } else {
      enrichedQuery[key] = fields[key]
    }
  }

  if (
    enrichedQuery.json ||
    enrichedQuery.customData ||
    enrichedQuery.requestBody
  ) {
    try {
      enrichedQuery.json = JSON.parse(
        enrichedQuery.json ||
          enrichedQuery.customData ||
          enrichedQuery.requestBody
      )
    } catch (err) {
      throw { message: `JSON Invalid - error: ${err}` }
    }
    delete enrichedQuery.customData
  }

  return enrichedQuery
}

exports.find = async function (ctx) {
  const db = new CouchDB(ctx.appId)
  const query = enrichQueries(await db.get(ctx.params.queryId))
  // remove properties that could be dangerous in real app
  if (env.isProd()) {
    delete query.fields
    delete query.parameters
    delete query.schema
  }
  ctx.body = query
}

exports.preview = async function (ctx) {
  const db = new CouchDB(ctx.appId)

  const datasource = await db.get(ctx.request.body.datasourceId)

  const Integration = integrations[datasource.source]

  if (!Integration) {
    ctx.throw(400, "Integration type does not exist.")
  }

  const { fields, parameters, queryVerb, transformer } = ctx.request.body
  const enrichedQuery = await enrichQueryFields(fields, parameters)
  const integration = new Integration(datasource.config)

  const { rows, keys } = await runAndTransform(
    integration,
    queryVerb,
    enrichedQuery,
    transformer
  )

  ctx.body = {
    rows,
    schemaFields: [...new Set(keys)],
  }
  // cleanup
  if (integration.end) {
    integration.end()
  }
}

exports.execute = async function (ctx) {
  const db = new CouchDB(ctx.appId)

  const query = await db.get(ctx.params.queryId)
  const datasource = await db.get(query.datasourceId)

  const Integration = integrations[datasource.source]

  if (!Integration) {
    ctx.throw(400, "Integration type does not exist.")
  }

  const enrichedQuery = await enrichQueryFields(
    query.fields,
    ctx.request.body.parameters
  )
  const integration = new Integration(datasource.config)

  // call the relevant CRUD method on the integration class
  const { rows } = await runAndTransform(
    integration,
    query.queryVerb,
    enrichedQuery,
    query.transformer
  )
  ctx.body = rows
  // cleanup
  if (integration.end) {
    integration.end()
  }
}

exports.destroy = async function (ctx) {
  const db = new CouchDB(ctx.appId)
  await db.remove(ctx.params.queryId, ctx.params.revId)
  ctx.message = `Query deleted.`
  ctx.status = 200
}
