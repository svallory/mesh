import type { Service } from "@meshfw/model";
import type { Generator } from "../emit.ts";
import { servicePath, serviceInputsView, serviceView, type ServiceInputsView, type ServiceView } from "../views/services.ts";
import { compareText, outputPrefix } from "./order.ts";

/** The project's services, by file: the order every generator and barrel lists them in. */
export const orderedServices = (services: readonly Service[] | undefined): Service[] => [...(services ?? [])].sort((a, b) => compareText(a.file, b.file));

/**
 * `<module>/<service>.service.ts` per service (services design, section 7; ruling D42): the service value, which the
 * module barrel exports under the service's name, its operations' bodies and policies, and their `uses` lines. Nothing
 * for a project without services.
 */
export const servicesGenerator: Generator<ServiceView> = {
  name: "services",
  template: "service.ts.jig",
  requires: ["@meshfw/runtime"],
  views(input) {
    return orderedServices(input.document.services).map((service) => {
      const path = `${outputPrefix(input.config)}/${servicePath(service)}.service.ts`;
      return { path, view: serviceView(input, service, path) };
    });
  },
};

/**
 * `<module>/<service>.inputs.ts` per service: each operation's input type, which the module barrel re-exports, and the
 * Zod schema the operation casts its input with. Nothing for a project without services.
 */
export const serviceInputsGenerator: Generator<ServiceInputsView> = {
  name: "service-inputs",
  template: "service-inputs.ts.jig",
  requires: ["zod"],
  views(input) {
    return orderedServices(input.document.services).map((service) => ({
      path: `${outputPrefix(input.config)}/${servicePath(service)}.inputs.ts`,
      view: serviceInputsView(input, service),
    }));
  },
};
