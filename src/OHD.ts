import EventEmitter from 'events';
import { Socket } from 'net';
import events from 'events';
import net from 'net';
import ServerStatus from './definitions/ServerStatus';
import MapQuery, { MapQueryProps } from './utils/MapQuery';
import RCONParser from './parser/RCONParser';
import PlayerKicked from './definitions/PlayerKicked';
import PlayerBanned from './definitions/PlayerBanned';
import { Teams } from './definitions/Teams';
import { setupVariableProxy } from './utils/Variables';
import { ServerVariables, UnsafeVariables } from './definitions/ServerVariables';
import VariableChanged from './definitions/VariableChanges';

enum PacketType {
  COMMAND = 0x02,
  AUTH = 0x03,
  RESPONSE_VALUE = 0x00,
  RESPONSE_AUTH = 0x02,
}

type RconResponse = {
  size: number;
  id: number;
  type: number;
  body: string;
}

/**!
 * node-rcon
 * Copyright(c) 2012 Justin Li <j-li.net>
 * MIT Licensed
 * Stripped Down and modified by @bombitmanbomb
 */
class Rcon extends EventEmitter {
  public host: string;
  public port: number;
  public password: string;
  public outstandingData: Buffer | null = null;
  public hasAuthed: boolean;
  protected _tcpSocket!: Socket;
  constructor(host: string, port: number, password: string) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.hasAuthed = false;
    events.EventEmitter.call(this);
  }

  _sendSocket(buf: Buffer): void {
    this._tcpSocket.write(buf.toString('binary'), 'binary');
  }
  connect(): void {
    this._tcpSocket = net.createConnection(this.port, this.host);
    this._tcpSocket
      .on('data', ((data: Buffer): void => {
        this._tcpSocketOnData(data);
      }).bind(this))
      .on('connect', ((): void => {
        this.socketOnConnect();
      }).bind(this))
      .on('error', ((err: Error): void => {
        this.emit('error', err);
      }).bind(this))
      .on('end', ((): void => {
        this.socketOnEnd();
      }).bind(this));
  }
  send(data: string, cmd: number, id = 0x0012d4a6) {
    cmd = cmd || PacketType.COMMAND;
    const length: number = Buffer.byteLength(data);
    const sendBuf: Buffer = Buffer.alloc(length + 14);
    sendBuf.writeInt32LE(length + 10, 0);
    sendBuf.writeInt32LE(id, 4);
    sendBuf.writeInt32LE(cmd, 8);
    sendBuf.write(data, 12);
    sendBuf.writeInt16LE(0, length + 12);

    this._sendSocket(sendBuf);
  }
  disconnect(): void {
    if (this._tcpSocket) this._tcpSocket.end();
  }
  setTimeout(timeout: number, callback: () => unknown): void {
    if (!this._tcpSocket) return;
    this._tcpSocket.setTimeout(timeout, ((): void => {
      this._tcpSocket.end();
      if (callback) callback();
    }).bind(this));
  }
  _tcpSocketOnData(data: Buffer): boolean | void {
    if (this.outstandingData != null) {
      data = Buffer.concat(
        [this.outstandingData, data],
        this.outstandingData.length + data.length
      );
      this.outstandingData = null;
    }

    while (data.length >= 12) {
      const len: number = data.readInt32LE(0); // Size of entire packet, not including the 4 byte length field
      if (!len) return; // No valid packet header, discard entire buffer

      const packetLen: number = len + 4;
      if (data.length < packetLen) break; // Wait for full packet, TCP may have segmented it

      const bodyLen: number = len - 10; // Subtract size of ID, type, and two mandatory trailing null bytes
      if (bodyLen < 0) {
        data = data.subarray(packetLen); // Length is too short, discard malformed packet
        break;
      }
      const id: number = data.readInt32LE(4);
      const type: number = data.readInt32LE(8);
      if (id == -1) return this.emit('error', new Error('Authentication failed'));

      if (!this.hasAuthed && type == PacketType.RESPONSE_AUTH) {
        this.hasAuthed = true;
        this.emit('auth');
      } else if (type == PacketType.RESPONSE_VALUE) {
        // Read just the body of the packet (truncate the last null byte)
        // See https://developer.valvesoftware.com/wiki/Source_RCON_Protocol for details
        let str: string = data.toString('utf8', 12, 12 + bodyLen);

        if (str.charAt(str.length - 1) === '\n') {
          // Emit the response without the newline.
          str = str.substring(0, str.length - 1);
        }

        const response = {
          size: data.readInt32LE(0),
          id: data.readInt32LE(4),
          type: data.readInt32LE(8),
          body: str,
        };
        this.emit('response', response);
      }

      data = data.subarray(packetLen);
    }

    // Keep a reference to remaining data, since the buffer might be split within a packet
    this.outstandingData = data;
  }


  socketOnConnect(): void {
    this.emit('connect');
    this.send(this.password, PacketType.AUTH);
  }
  socketOnEnd(): void {
    this.emit('end');
    this.hasAuthed = false;
  }
}

type ResponsePromiseQueueObject = {
  time: Date;
  buffer: string;
  handled: boolean;
  resolve: (data: unknown) => void;
  reject: (reason: unknown) => void;
  timeOut: NodeJS.Timeout;
}


/**
 * Primary Interface Object for OHD servers.
 */
export default class OHD {
  /**
   * Rejects if an error occurs when connecting.
   */
  public onReady: Promise<null>;
  public rconParser: RCONParser;
  protected messageID = 1;
  protected _conn!: Rcon;
  protected _isAuthorized!: boolean;
  protected _responsePromiseQueue!: Map<number, ResponsePromiseQueueObject>;
  constructor(ip: string, port: number, password: string) {
    this.rconParser = new RCONParser(this);
    Object.defineProperty(this, '_isAuthorized', { enumerable: false, value: false });
    Object.defineProperty(this, '_responsePromiseQueue', { enumerable: false, value: new Map });
    Object.defineProperty(this, '_onResponse', { enumerable: false, value: this._onResponse.bind(this) });
    Object.defineProperty(this, '_onError', { enumerable: false, value: this._onError.bind(this) });
    Object.defineProperty(this, '_onEnd', { enumerable: false, value: this.onEnd.bind(this) });
    Object.defineProperty(this, '_conn', { enumerable: false, value: new Rcon(ip, port, password) });
    this.onReady = new Promise((res, rej) => {
      let handled = false;
      this._conn.once('error', (err) => {
        if (handled) return;
        handled = true;
        rej(err);
      });
      this._conn.once('auth', (): void => {
        if (handled) return;
        handled = true;
        res(null);
      });
    });
    this._conn
      .on('response', this._onResponse)
      .on('error', this._onError)
      .on('end', this.onEnd);

    this._conn.connect();
  }

  /**
   * Get the Server Status.
   */
  public status(): Promise<ServerStatus> {
    //eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.send('status').then((status: any) => {
      return {
        ...status.status,
        Players: status.players
      };
    });
  }
  /**
   * Add `amount` bots to the server.
   */
  public addBots(amount = 1): Promise<void> {
    return this.send(`addBots ${amount}`) as Promise<void>;
  }
  /**
   * Add a Named Bot to the server.
   */
  public addNamedBot(name = 'Chuck Norris'): Promise<void> {
    return this.send(`addNamedBot ${name}`) as Promise<void>;
  }
  /**
   * Add bots to a specified Team
   */
  public addTeamBots(team: 0 | 1 | Teams, amount: number): Promise<unknown> {
    return this.send(`addTeamBots ${team} ${amount}`);
  }
  /**
   * Add bots to the Opfor Team
   */
  public addOpforBots(amount: number): Promise<unknown> {
    return this.send(`addOpforBots ${amount}`);
  }
  /**
   * Add bots to the Blufor Team
   */
  public addBluforBots(amount: number): Promise<unknown> {
    return this.send(`addBluforBots ${amount}`);
  }
  /**
   * Remove bots from the specified Team
   */
  public removeTeamBots(team: 0 | 1 | Teams, amount: number): Promise<unknown> {
    return this.send(`removeTeamBots ${team} ${amount}`);
  }
  /**
   * Remove bots from the Opfor Team
   */
  public removeOpforBots(amount: number): Promise<unknown> {
    return this.send(`removeOpforBots ${amount}`);
  }
  /**
   * Remove bots from the Blufor Team
   */
  public removeBluforBots(amount: number): Promise<unknown> {
    return this.send(`removeBluforBots ${amount}`);
  }
  /**
   * Set the state of FriendlyFire
   * @depricated use OHD.variables
   */
  public friendlyFire(enabled: boolean | 0 | 1): Promise<VariableChanged> {
    return this.variables.Game.FriendlyFire.write(enabled ? '1' : '0');
  }
  /**
   * Forces all new players to the specified team. Users can not change to any other team.
   *
   * @note This does not force change existing players team, only new ones
   * @depricated use OHD.variables
   */
  public autoAssignHumanTeam(team: -1 | 0 | 1 | Teams): Promise<VariableChanged> {
    return this.variables.Game.AutoAssignHumanTeam.write(team.toString() as '-1');
  }
  /**
   * Enable/Disable Team Autobalancing
   * @depricated use OHD.variables
   */
  public autoBalanceTeamsOverride(enabled: boolean | 0 | 1): Promise<VariableChanged> {
    return this.variables.Game.AutoBalanceTeamsOverride.write(enabled ? '1' : '0')
  }
  /**
   * Remove all bots from the server.
   */
  public removeAllBots(): Promise<void> {
    return this.send('removeAllBots') as Promise<void>;
  }
  /**
   * Set the bot autofill variable
   * @depricated use OHD.variables
   */
  public botAutofill(enabled: boolean | 0 | 1): Promise<VariableChanged> {
    return this.variables.Bot.Autofill.write(enabled ? '1' : '0');
  }
  /**
   * Kick a `Player` from the server by Username
   */
  public kick(name: string, reason = 'You have been Kicked'): Promise<PlayerKicked> {
    return this.send(`kick "${name}" "${reason}"`) as Promise<PlayerKicked>;
  }
  /**
   * Kick a `Player` from the server by PlayerID
   */
  public kickId(id: number, reason = 'You have been Kicked'): Promise<PlayerKicked> {
    return this.send(`kickId ${id} "${reason}"`) as Promise<PlayerKicked>;
  }
  /**
   * Ban a `Player` from the server by Username.
   */
  public ban(name: string, /** Duration in Seconds*/ duration = 0, reason?: string,): Promise<PlayerBanned> {
    if (reason == null) reason = duration == 0 ? 'You have been Permanently Banned!' : `You have been Banned for ${duration} minutes!`;
    return this.send(`ban "${name}" "${reason}" ${duration}`) as Promise<PlayerBanned>;
  }
  /**
   * Ban a `Player` from the server by PlayerID.
   */
  public banId(id: number, /** Duration in Seconds*/ duration = 0, reason?: string): Promise<PlayerBanned> {
    if (reason == null) reason = duration == 0 ? 'You have been Permanently Banned!' : `You have been Banned for ${duration} minutes!`;
    return this.send(`banId ${id} "${reason}" ${duration}`) as Promise<PlayerBanned>;
  }
  /**
   * Create a new MapQuery Object to use with `serverTravel()`.
   */
  public createMapQuery(options?: MapQueryProps): MapQuery {
    return new MapQuery(options);
  }
  /**
   * Force the team of a `Player` by Username.
   *
   * 1: Blufor
   *
   * 0: Opfor
   */
  public forceTeam(name: string, teamId: 0 | 1 | Teams): Promise<unknown> {
    return this.send(`ForceTeam "${name}" ${teamId}`);
  }
  /**
   * Force the team of a `Player` by PlayerID.
   *
   * 1: Blufor
   *
   * 0: Opfor
   */
  public forceTeamId(id: number, teamId: 0 | 1 | Teams): Promise<unknown> {
    return this.send(`ForceTeamId ${id} ${teamId}`);
  }
  /**
   * Dot Access Setter for Server Variables.
   *
   * Do not ever set an accessor to a variable, always use .read() and .write()
   */
  get variables() {
    return setupVariableProxy<ServerVariables>(this);
  }
  /**
   * Dot Access Setter for Server Variables.
   *
   * Do not ever set an accessor to a variable, always use .read() and .write()
   */
  get variablesUnsafe() {
    return setupVariableProxy<UnsafeVariables>(this);
  }
  /**
   * Set the AutoAssignHuman variable.
   *
   * -1: Disable
   *
   *  0: Opfor
   *
   *  1: Blufor
   * @depricated use OHD.variables
   */
  public autoAssignHuman(team: -1 | 0 | 1 | Teams = -1): Promise<VariableChanged> {
    return this.variables.Game.AutoAssignHumanTeam.write(team.toString() as '-1');
  }
  /**
   * Set the respawn delay
   * @depricated use OHD.variables
   */
  public minRespawnDelay(seconds: number): Promise<VariableChanged> {
    return this.variables.HD.Game.MinRespawnDelayOverride.write(seconds.toString() as '0');
  }
  /**
   * Change the current Level.
   */
  public serverTravel(map: MapQuery | string): Promise<unknown> {
    let mapString: string;
    if (map instanceof MapQuery) {
      mapString = map.toString();
    } else {
      mapString = map as string;
    }
    return this.send(`serverTravel ${mapString}`);
  }
  /**
   * Send a message to all players.
   *
   * @note These messages only display from the in-game console currently.
   */
  public say(message: string): Promise<unknown> {
    return this.send(`say "${message}"`);
  }
  /**
   * Send a Raw RCON command.
   */
  public send(cmd: string): Promise<unknown> {
    const id: number = this.messageID++;

    return new Promise((resolve, reject) => {
      const ob: ResponsePromiseQueueObject = {
        time: new Date(),
        buffer: '',
        handled: false,
      } as ResponsePromiseQueueObject;
      ob.resolve = (dat: unknown): void => {
        ob.handled = true;
        resolve(dat);
      };
      ob.reject = (dat: unknown): void => {
        ob.handled = true;
        reject(dat);
      };
      //? Timeout in the event of the final packet is Max packet length
      ob.timeOut = setTimeout((): void => {
        if (ob.handled) return;
        ob.handled = true;
        ob.resolve(this._parseResponse(ob.buffer) ?? ob.buffer);
      }, 5000);
      this._responsePromiseQueue.set(id, ob);
      this._conn.send(cmd, 0x02, id);
    });
  }

  protected _onResponse(response: RconResponse): void {
    const size: number = response?.size;
    if (this._responsePromiseQueue.has(response.id)) {
      const q: ResponsePromiseQueueObject = this._responsePromiseQueue.get(response.id) as ResponsePromiseQueueObject;
      if (size >= 4092) {
        //MAX PACKET SIZE, MIGHT BE SPLIT
        q.buffer += response.body;
        return;
      }
      //eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any =
        this._parseResponse((q.buffer ?? '') + response.body) ?? response;
      if (res.success === false) {
        q.reject(res.data);
      } else {
        q.resolve(res.data ?? res);
      }
      this._responsePromiseQueue.delete(response.id);
      return;
    }
    // Non command
    //TODO
  }
  /**
   * Disconnect the client.
   */
  public disconnect(): void {
    this._conn.disconnect();
  }
  protected _parseResponse(res: string): unknown {
    const data: string = res?.replaceAll('\\n', '\n');
    if (data == null || data?.trim?.() == '') return null;
    return this.rconParser.parse(data);
  }
  protected _onError(str: string): void {
    console.error(str);
  }
  protected onEnd(): void {
    //TODO: onEnd
  }
}
