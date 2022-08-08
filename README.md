# TelegraDB
It's ridiculous, using the "telegra.ph" as a database.

This is really slow, and unsafe for your data.

**Don't use in any product!!!**

Use standar web api, can be used in deno.

```javascript
import { TelegraDB, initTelegraDB } from "./telegraph.js";
const { accessToken, indexPath } = await initTelegraDB();
const db = new TelegraDB(accessToken, indexPath);
await db.loadIndex();
await db.createItem("test", { name: "Dragon" });
await db.saveIndex();
await db.updateItem("test", { name: "Wyvern" });
db.getItemTitles().forEach(async (title) => {
console.log(title, await db.getItem(title));
});
```