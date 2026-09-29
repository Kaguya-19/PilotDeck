import { listWebProjects, describeWebProject } from '../../../src/web/server/listProjects.js';
import { readWebSessionMessages, readSubagentWebMessages } from '../../../src/web/server/readSessionMessages.js';
import { listProjectSessions } from '../../../src/session/index.js';

// The same disk readers used by Gateway, without creating an agent runtime.
// Only history reads are exposed while an intentionally empty pool stops Gateway.
export function createModelFreeHistory({ pilotHome, projectRoot }) {
  const options = { pilotHome, projectRoot };
  return {
    listProjects: () => listWebProjects({ pilotHome }),
    describeProject: (input) => describeWebProject(input.projectKey, { pilotHome }),
    readSessionMessages: (input) => readWebSessionMessages(input, options),
    readSubagentMessages: (input) => readSubagentWebMessages(input, options),
    async listSessions(input) {
      const parsed = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      const offset = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
      const sessions = await listProjectSessions({
        pilotHome, projectRoot: input.projectKey || projectRoot, limit: input.limit, offset,
      });
      return { sessions, nextCursor: input.limit && sessions.length === input.limit ? String(offset + sessions.length) : undefined };
    },
  };
}
