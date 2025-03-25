const { readdirSync } = require("fs");
const ascii = require("ascii-table");

const guildID = '215570552205606913'

let table = new ascii("Commands");
table.setHeading("Command", "Load status");

module.exports = (client) => {
  try{
      const commands = readdirSync(`./commands/`).filter((file) => file.endsWith(".js"));
      for (let file of commands) {
          console.log(file);
          let pull = require(`../commands/${file}`);
          let commandName = file.split(".")[0];
          if (pull.name) {
              client.guilds.cache.get(guildID)?.commands.create(pull.toJSON());
              //client.commands.set(pull.name, pull);
              table.addRow(commandName, "Ready");
          } else {
              table.addRow(commandName, `error->missing a help.name,or help.name is not a string.`);
              continue;
          }
          if (pull.aliases && Array.isArray(pull.aliases)) pull.aliases.forEach((alias) => client.aliases.set(alias, pull.name));
      }
    console.log(table.toString().cyan);
  }catch (e){
    console.log(String(e.stack).bgRed)
  }
};

