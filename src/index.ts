// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { Snake } from "tgsnake";
import { Api } from "telegram";
import { exit } from "process";

const acceptedType = ["vmess", "vless", "trojan", "ss", "http", "https"];
const subKeyword = ["sub", "api", "clash", "token", "v1.mk", "paste", "proxy", "proxies", ".txt", ".yml", ".yaml"];
const forbiddenKeyword = ["t.me", "telegram.org", " "];
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

    for await (const dialog of bot.client.iterDialogs({})) {
      if (dialog.isGroup) {
        peers.push(
          new Api.InputPeerChat({
            chatId: dialog.entity.id,
          })
        );
      } else if (dialog.isChannel) {
        if (dialog.entity.accessHash) {
          peers.push(
            new Api.InputPeerChannel({
              channelId: dialog.entity.id,
              accessHash: dialog.entity.accessHash,
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
      try {
        const result = await bot.client.invoke(
          new Api.messages.GetHistory({
            peer: peer,
          })
        );

        if (result.className == "messages.Messages" || result.className == "messages.ChannelMessages") {
          for (const message of result.messages) {
            if (message.className == "Message") {
              if (message.media && message.media?.className == "MessageMediaDocument") {
                const media = message.media;
                const doc = message.media.document;
                if (doc?.className == "Document") {
                  switch (doc.mimeType) {
                    case "text/plain":
                      try {
                        const buffer = await bot.client.downloadMedia(media, {
                          workers: 1,
                        });
                        message.message = buffer.toString();
                      } catch (e) {
                        console.error(e.message);
                      }
                  }
                }
              }

              messages.push(message);
            }
          }
        }
      } catch (e) {
        console.error(e.message);
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
            url: [
              ...links,
              "https://sub.pmsub.me/base64",
              "https://shadowmere.akiel.dev/api/b64sub",
              "https://raw.githubusercontent.com/anaer/Sub/main/clash.yaml",
              "https://raw.githubusercontent.com/free18/v2ray/refs/heads/main/v.txt",
              "https://raw.githubusercontent.com/yebekhe/ConfigCollector/main/sub/mix",
              "https://raw.githubusercontent.com/shabane/kamaji/master/hub/merged.txt",
              "https://raw.githubusercontent.com/LalatinaHub/Mineral/master/result/nodes",
              "https://raw.githubusercontent.com/Pawdroid/Free-servers/refs/heads/main/sub",
              "https://raw.githubusercontent.com/tbbatbb/Proxy/master/dist/v2ray.config.txt",
              "https://raw.githubusercontent.com/youfoundamin/V2rayCollector/main/mixed_iran.txt",
              "https://raw.githubusercontent.com/Leon406/SubCrawler/refs/heads/main/sub/share/a11",
              "https://raw.githubusercontent.com/Bardiafa/Free-V2ray-Config/main/All_Configs_Sub.txt",
              "https://raw.githubusercontent.com/Leon406/SubCrawler/refs/heads/main/sub/share/vless",
              "https://raw.githubusercontent.com/w1770946466/Auto_proxy/main/Long_term_subscription_num",
              "https://raw.githubusercontent.com/mahdibland/ShadowsocksAggregator/master/sub/sub_merge.txt",
              "https://raw.githubusercontent.com/Mahdi0024/ProxyCollector/refs/heads/master/sub/proxies.txt",
              "https://raw.githubusercontent.com/barry-far/V2ray-Configs/refs/heads/main/All_Configs_Sub.txt",
              "https://raw.githubusercontent.com/Epodonios/v2ray-configs/refs/heads/main/All_Configs_Sub.txt",
              "https://nautica.foolvpn.me/api/v1/sub?format=raw&domain=meet.google.com&port=443&limit=100000&vpn=ss",
              "https://raw.githubusercontent.com/WilliamStar007/ClashX-V2Ray-TopFreeProxy/main/combine/v2raysub.txt",
              "https://raw.githubusercontent.com/WilliamStar007/ClashX-V2Ray-TopFreeProxy/main/combine/clashsub.txt",
            ].join("|"),
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
  const peers: Array<PeersType> = [];
  const messages: Array<Api.TypeMessage> = [];

  try {
    await bot.start();

    peers.push(...(await mineral.getPeers()));
    messages.push(...(await mineral.getMessages(peers)));
  } catch (e: Error) {
    console.error(e);
  } finally {
    await mineral.scrape(messages);
  }

  await bot.disconnect();
  console.log("\n");
  console.log("Process completed !");
  exit(0);
})();
