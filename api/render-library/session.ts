import { route } from '../../src/render-library/server/runtime.js'
export const GET = (request: Request) => route(request, 'session')
