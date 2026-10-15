export const isStaff = (actor: { id: string }): boolean => actor.id.startsWith("staff-");
