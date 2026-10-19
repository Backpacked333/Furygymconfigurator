import { route } from '../../src/render-library/server/runtime.js'
export const POST = (request: Request) => route(request, 'lookup')
