// The project's events module: `log` (listen) records every event the project publishes, listed on a surface or not.
import { Mesh } from "meshfw";
import { TaskArchived, TaskCompleted, TaskTouched } from "#mesh/domain/work";

export const seen: string[] = [];

export const handlers = {
  listen: {
    log: Mesh.handler({
      events: [TaskCompleted, TaskArchived, TaskTouched],
      run: (event) => {
        seen.push(event.name);
      },
    }),
  },
};
