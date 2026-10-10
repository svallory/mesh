import { buildModel } from "../src/front-end/build.ts";
export const keyed = "entity :Todo\n  attributes\n    uuid :id primary-key\n";
export const todo = `import { List } from "./list.mesh.mx"
entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1 max=100 match=/^.+$/
    boolean :done default=false
    enum :status values=[:draft, :sent] default=:draft
    integer :views default=0
    float :rating nullable
    decimal :amount min=0 default=0
    date :dueOn nullable
    datetime :paidAt nullable
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update
    json :metadata nullable
  relationships
    belongs-to :list entity=List
    has-many :children entity=List
    has-one :detail entity=List
  computed
    string :label({ self }) { return self.title }
    count :childCount of="children"
    sum :total of="children.amount"
    avg :average of="children.amount"
    min :smallest of="children.amount"
    max :largest of="children.amount"
  actions auto=[:read, :destroy]
    always types=[:create, :update]
      validate
        check :valid that=({ self }) => self.amount >= 0 code="invalid" message="bad amount" when=() => true
      do
        run({ self, actor }) { console.log(self, actor) }
    create :create
      input
        &title
        &list
        &status
        string :reason nullable
    update :complete
      input
        &title
        integer :count min=1
      validate
        check :notDone that=({ self }) => !self.done code="done" message="already done"
      do
        set
          &done=true
          &status=:sent
        when=({ self }) => self.amount > 100
          set
            &views=({ input }) => input.count
    read :pending
      input
        uuid :listId
      filter=({ input, self }) => self.list.id === input.listId
  policies
    policy :owner types=[:read] when=() => true
      authorize-if=({ actor }) => !!actor
      authorize-if=() => true
      forbid-if=() => false
    policy :staff types=[:create, :update, :destroy] authorize-if=({ actor }) => !!actor
`;
export const list =
  "entity :List\n  attributes\n    uuid :id primary-key\n    decimal :amount\n";
export const project = (source = todo) => ({
  root: "/project",
  files: [
    { file: "todo/todo.mesh.mx", source },
    { file: "todo/list.mesh.mx", source: list },
  ],
});
export const build = (source: string) =>
  buildModel({
    root: "/project",
    files: [{ file: "todo/todo.mesh.mx", source }],
  });
