import { route } from '../../src/render-library/server/runtime'
export const POST = (request: Request) => route(request, 'lookup')
