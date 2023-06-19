import { RegexController, Request, Response } from '../regex'

export class HealthController implements RegexController {

    static path = '^/health/(liveness|readiness)$'

    async get(request: Request, response: Response) {
        response.setStatusCode(200)
        response.end()
    }

}