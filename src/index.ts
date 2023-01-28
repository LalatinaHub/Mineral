import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { Snake } from "tgsnake";
import { Api } from "telegram";
import { exit } from "process";

const acceptedType = ["vmess", "vless", "ssr", "ss", "http", "https"];
const subKeyword = ["sub", "api", "clash", "token", "v1.mk", "paste", "proxy", "proxies", ".txt", ".yml", ".yaml"];
const forbiddenKeyword = ["t.me", " "];
const pattern = new RegExp(`(${acceptedType.join("|")})://.+`);

const bot = new Snake({
  apiHash: readFileSync("./api_hash").toString(),
  apiId: parseInt(readFileSync("./api_id").toString()),
  session: readFileSync("./session").toString(),
  tgsnakeLog: false,
  logger: "error",
});

type PeersType = Api.InputPeerChannel | Api.InputPeerChat;

class Mineral {
  async getPeers() {
    const peers: PeersType[] = [];
    const result = await bot.client.invoke(
      new Api.messages.GetAllChats({
        exceptIds: [],
      })
    );

    for (const chat of result.chats) {
      if (chat.className == "Chat") {
        peers.push(
          new Api.InputPeerChat({
            chatId: chat.id,
          })
        );
      } else if (chat.className == "Channel") {
        if (chat.accessHash) {
          peers.push(
            new Api.InputPeerChannel({
              channelId: chat.id,
              accessHash: chat.accessHash,
            })
          );
        }
      }
    }

    return peers;
  }

  async getMessages(peers: PeersType[]) {
    const messages: Api.TypeMessage[] = [];
    for (const peer of peers) {
      const result = await bot.client.invoke(
        new Api.messages.GetHistory({
          peer: peer,
        })
      );

      if (result.className == "messages.Messages" || result.className == "messages.ChannelMessages") {
        for (const message of result.messages) {
          if (message.className == "Message") {
            messages.push(message);
          }
        }
      }
    }

    return messages;
  }

  async scrape(messages: Api.TypeMessage[]) {
    const nodes: string[] = [];
    const links: string[] = [];

    for (const message of messages) {
      if (message.className == "Message") {
        for (const lineMessage of message.message.split("\n")) {
          const matchType = lineMessage.match(pattern);
          if (matchType) {
            const type = matchType[0].match(new RegExp(`^(${acceptedType.join("|")})`));
            let node = matchType[0];
            let link = matchType[0];

            if (type) {
              switch (type[0]) {
                case "vmess":
                  if (node.match(/[@\.]/)) break;
                  node = node.replace(/(=|\s).*/, "");

                  if (!nodes.includes(node)) {
                    nodes.push(node);
                  }
                  break;
                case "http":
                case "https":
                  if (link.match(new RegExp(`(${forbiddenKeyword.join("|")})`))) {
                    break;
                  } else if (link.match(new RegExp(`(${subKeyword.join("|")})`))) {
                    if (!links.includes(link)) {
                      links.push(link);
                    }
                  }
                  break;
                default:
                  if (node.match(/[\s]/)) break;
                  if (!nodes.includes(node)) {
                    nodes.push(node);
                  }
              }
            }
          }
        }
      }
    }

    console.log(`Found ${nodes.length} nodes!`);
    console.log(`Found ${links.length} subs!`);

    if (!existsSync("./result")) mkdirSync("./result");
    writeFileSync("./result/nodes", nodes.join("\n"));
    writeFileSync("./result/subs", links.join("\n"));
    writeFileSync(
      "./result/sub.json",
      JSON.stringify(
        [
          {
            id: 0,
            remarks: "LalatinaHub/Mineral",
            site: "https://github.com/LalatinaHub/Mineral",
            url: links.join("|") + "|https://raw.githubusercontent.com/LalatinaHub/Mineral/master/result/nodes",
            update_method: "auto",
            enabled: true,
          },
        ],
        null,
        2
      )
    );
  }
}

const mineral = new Mineral();

(async () => {
  await bot.start();

  const peers = await mineral.getPeers();
  const messages = await mineral.getMessages(peers);
  await mineral.scrape(messages);

  await bot.disconnect();
  exit(0);
})();
