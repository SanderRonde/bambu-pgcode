import { join } from "path";
import * as mqtt from "mqtt";
import { Client } from "basic-ftp";
import * as fs from "fs/promises";
import { config } from "dotenv";
import { Mutex } from "async-mutex";

config();

const disposables: (() => void)[] = [];

const GCODES_DIR = join(import.meta.dir, "../gcodes");

class BambuFTP {
    private _ftp!: Client;
    private _mutex = new Mutex();

    public constructor(
        private readonly _printerIp: string,
        private readonly _printerAccessCode: string
    ) {}

    public async connect() {
        this._ftp = new Client();
        try {
            // Configure for implicit FTPS - this is the key difference
            console.log("Connecting to FTP server");
            await this._ftp.access({
                host: this._printerIp,
                port: 990,
                user: "bblp",
                password: this._printerAccessCode,
                secure: "implicit", // This is crucial for Bambu Lab printers
                secureOptions: {
                    rejectUnauthorized: false, // Accept self-signed certificates
                },
            });

            console.log("Connected to FTP server successfully");

            disposables.push(() => {
                console.log("Closing FTP connection");
                this._ftp.close();
            });
        } catch (error) {
            console.error("Failed to connect to FTP server:", error);
            this._ftp.close();
            throw error;
        }
    }

    public async getFile(fileName: string) {
        console.log("getFile", fileName);
        return this._mutex.runExclusive(async () => {
            await fs.mkdir(GCODES_DIR, { recursive: true });
            const localFilePath = join(GCODES_DIR, fileName);
            const file = Bun.file(localFilePath);
            if (await file.exists()) {
                return file;
            }

            if (this._ftp.closed) {
                await this.connect();
            }

            const remoteFiles = [
                ...(await this._ftp.list()).map(
                    (file) => [file.name, file.name] as const
                ),
                ...(await this._ftp.list("model")).map(
                    (file) => [file.name, `model/${file.name}`] as const
                ),
            ];
            const remoteFile = remoteFiles.find(
                (file) =>
                    file[0].replaceAll(/\s/g, "_") ===
                    fileName.replaceAll(/\s/g, "_")
            );
            if (!remoteFile) {
                return null;
            }
            console.log("downloading", remoteFile[1]);
            await this._ftp.downloadTo(
                join(GCODES_DIR, fileName),
                remoteFile[1]
            );
            if (!(await file.exists())) {
                throw new Error(`File failed to download`);
            }
            return file;
        });
    }
}

class BambuMQTT {
    private _client!: mqtt.MqttClient;

    public fileName: string | null = null;
    public layerCount: number | null = null;

    public constructor(
        private readonly _printerIp: string,
        private readonly _printerAccessCode: string,
        private readonly _printerSerial: string
    ) {}

    public async connect() {
        console.log(`Connecting to printer at ${this._printerIp}:8883`);
        console.log(
            `Using access code: ${this._printerAccessCode.substring(0, 4)}****`
        );
        console.log(`Printer serial: ${this._printerSerial}`);

        try {
            this._client = await mqtt.connectAsync(
                `mqtt://${this._printerIp}`,
                {
                    username: "bblp",
                    password: this._printerAccessCode,
                    port: 8883,
                    protocol: "mqtts",
                    protocolVersion: 4, // MQTT v3.1.1
                    rejectUnauthorized: false,
                    ca: [], // Empty CA list to accept self-signed certificates
                    connectTimeout: 10000,
                    keepalive: 10,
                }
            );
        } catch (error) {
            console.error("Failed to connect to printer:", error);
            throw error;
        }

        disposables.push(() => {
            console.log("Disconnecting MQTT client");
            if (this._client && this._client.connected) {
                this._client.end();
            }
        });

        this._client.on("close", () => {
            console.log("MQTT client closed");
        });

        this._client.on("error", (err) => {
            console.error("MQTT client error", err);
        });

        this._client.on("connect", () => {
            console.log("MQTT client successfully connected");
        });

        this._client.on("reconnect", () => {
            console.log("MQTT client reconnecting...");
        });

        this._client.on("offline", () => {
            console.log("MQTT client went offline");
        });

        // Wait a moment for the connection to fully establish
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (!this._client.connected) {
            throw new Error(
                "MQTT client failed to connect within timeout period"
            );
        }

        console.log("MQTT connection established, subscribing to topics...");

        // Subscribe to the printer report topic
        await new Promise<void>((resolve, reject) => {
            this._client.subscribe(
                `device/${this._printerSerial}/report`,
                (err) => {
                    if (err) {
                        console.error("Error subscribing to report topic", err);
                        reject(err);
                    } else {
                        console.log("Subscribed to printer MQTT report topic");
                        resolve();
                    }
                }
            );
        });

        // Send initial pushall command to get full printer state (like Python implementation)
        const commandTopic = `device/${this._printerSerial}/request`;
        const initCommands = {
            pushing: { command: "pushall" },
            info: { command: "get_version" },
            upgrade: { command: "get_history" },
        };

        this._client.publish(commandTopic, JSON.stringify(initCommands));
        console.log("Sent initial pushall command");

        this._client.on("message", (topic, message) => {
            try {
                const data = JSON.parse(message.toString());
                this._onMessage(data);
            } catch (e) {
                console.log(
                    "Received non-JSON message",
                    topic,
                    message.toString()
                );
            }
        });
    }

    private _onMessage(message: {
        print?: {
            gcode_file?: string;
            layer_num?: number;
        };
    }) {
        if (message.print?.gcode_file) {
            console.log("gcode_file", message.print.gcode_file);
            this.fileName = message.print.gcode_file;
        }
        if (message.print?.layer_num) {
            console.log("layer_num", message.print.layer_num);
            this.layerCount = Number(message.print.layer_num);
        }
    }
}

const CLIENT_DIR = join(import.meta.dir, "../client");
async function main() {
    const ip = process.env.PRINTER_IP;
    const accessCode = process.env.PRINTER_ACCESS_CODE;
    const serial = process.env.PRINTER_SERIAL;
    if (!ip || !accessCode || !serial) {
        throw new Error("Missing environment variables");
    }

    const ftp = new BambuFTP(ip, accessCode);
    await ftp.connect();

    const bambu = new BambuMQTT(ip, accessCode, serial);
    await bambu.connect();

    Bun.serve({
        port: process.env.PORT,
        hostname: "0.0.0.0",

        routes: {
            "/": () => new Response(Bun.file(join(CLIENT_DIR, "index.html"))),
            "/favicon.ico": () =>
                new Response(Bun.file(join(CLIENT_DIR, "favicon.ico"))),
            "/js/:file_name": (request) =>
                new Response(
                    Bun.file(join(CLIENT_DIR, "js", request.params.file_name))
                ),
            "/img/:file_name": (request) =>
                new Response(
                    Bun.file(join(CLIENT_DIR, "img", request.params.file_name))
                ),
            "/api/gcode_name": () => {
                return new Response(
                    JSON.stringify({ fileName: bambu.fileName })
                );
            },
            "/api/layer_count": () => {
                return new Response(
                    JSON.stringify({ layerCount: bambu.layerCount })
                );
            },
            "/api/gcode": async () => {
                const fileName = bambu.fileName;
                if (!fileName) {
                    return new Response("No file name", { status: 400 });
                }

                const file = await ftp.getFile(fileName);
                if (!file) {
                    return new Response("File not downloaded", { status: 404 });
                }
                return new Response(file);
            },
        },
    });
    console.log(`🚀 Server running on http://0.0.0.0:${process.env.PORT}`);
}

process.on("beforeExit", () => {
    console.log("Disposing of disposables");
    disposables.forEach((d) => d());
    process.exit(0);
});

if (import.meta.main) {
    main();
}
