import { route } from '../../src/render-library/server/runtime'
export const GET = (request: Request) => route(request, 'session')
