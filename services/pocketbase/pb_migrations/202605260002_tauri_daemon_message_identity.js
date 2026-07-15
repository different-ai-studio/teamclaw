function addTextField(collection, name, max) {
  if (!collection.fields.getByName(name)) {
    collection.fields.add(new TextField({ name, max }));
  }
}

function removeField(collection, name) {
  const field = collection.fields.getByName(name);
  if (field) {
    collection.fields.remove(field.id);
  }
}

migrate((app) => {
  const messages = app.findCollectionByNameOrId("messages");
  addTextField(messages, "client_message_id", 80);
  messages.indexes = messages.indexes.filter((idx) => !idx.includes("idx_messages_session_client_message"));
  messages.indexes.push(
    "CREATE UNIQUE INDEX idx_messages_session_client_message ON messages (session, client_message_id) WHERE client_message_id != ''",
  );
  app.save(messages);

  const runtimes = app.findCollectionByNameOrId("agent_runtimes");
  addTextField(runtimes, "last_processed_message_key", 80);
  app.save(runtimes);
}, (app) => {
  const runtimes = app.findCollectionByNameOrId("agent_runtimes");
  removeField(runtimes, "last_processed_message_key");
  app.save(runtimes);

  const messages = app.findCollectionByNameOrId("messages");
  messages.indexes = messages.indexes.filter((idx) => !idx.includes("idx_messages_session_client_message"));
  removeField(messages, "client_message_id");
  app.save(messages);
});
