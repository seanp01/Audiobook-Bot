const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
  name: 'youtube',
  data: new SlashCommandBuilder()
    .setName('youtube')
    .setDescription('Streams media from link')
    .addStringOption(option =>
      option.setName('url')
          .setDescription('link to youtube video')
          .setRequired(true)),
}

// module.exports = {
//     name: "stream",
//     category: "Entertainment",
//     aliases: [""],
//     cooldown: 2,
//     //type: ApplicationCommandType.ChatInput,
//     usage: "stream <TEXT>",
//     description: "Streams media from link",
//     run: async (client, messageCreate, args, user, text, prefix) => {
//     try{
//       if(!args[0])
//         return messageCreate.channel.send(new MessageEmbed()
//             .setColor(ee.wrongcolor)
//             .setFooter(ee.footertext, ee.footericon)
//             .setTitle(`❌ ERROR | You didn't provide a Link`)
//             .setDescription(`Usage: \`${prefix}${this.usage}\``)
//         );
//       messageCreate.channel.send(text);
//       console.log('url received! ' + args[0])
//       const url = args[0];
//       await axios.post('http://10.0.0.74:5000/open_url', { url: url })
//         .then(response => {
//           console.log(response.data);
//         })
//         .catch(error => {
//           console.error(error);
//         });
//     } catch (e) {
//         console.log(String(e.stack).bgRed)
//         return messageCreate.channel.send(new MessageEmbed()
//             .setColor(ee.wrongcolor)
//             .setFooter(ee.footertext, ee.footericon)
//             .setTitle(`❌ ERROR | An error occurred`)
//             .setDescription(`\`\`\`${e.stack}\`\`\``)
//         );
//     }
//   }
// }