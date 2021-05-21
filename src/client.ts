import 'isomorphic-fetch'
import WebSocket from 'isomorphic-ws'
import { EventEmitter } from 'events'
import { Instance, Options as SimplePeerOptions } from 'simple-peer'

const ACTION_CONNECT = 'Connect'

export interface SessionDescription {
    type: RTCSdpType
    sdp: string
    candidate?: string
}

export interface Options {
    host?: string
    port?: number
    path?: string
    url?: string
    secure?: boolean
    token?: string
    autoReconnect?: boolean
    reconnectInterval?: number
    reconnectIntervalMultiplier?: number
    wrtc?: unknown
}

export interface StreamInfo {
    id: string
    name: string
    port: number
}

export interface OutgoingMessage {
    action: string
    stream: string
    data: SessionDescription
    token?: string
}

export interface Message {
    action: string
    status: number
    stream: string
    data: SessionDescription
}

interface Callback {
    stream: string
    resolve: (data: SessionDescription) => void
    reject: (err: ClientError) => void
}

export class ClientError extends Error {
    public msg?: Message
}

const DEFAULT_OPTS = {
    host: '127.0.0.1',
    token: '',
    secure: false,
    autoReconnect: true,
    reconnectInterval: 2000,
    reconnectIntervalMultiplier: 1,
}

export class ChakraClient extends EventEmitter {
    public static createPeer: (opts?: SimplePeerOptions) => Instance

    private opts: Options
    private socket: WebSocket
    private reconnectTries = 0
    private destroyed = false
    private connected = false
    private callbacks: Callback[] = []

    private get hostname(): string {
        return `${this.opts.host}:${this.opts.port}`
    }

    private get wsUrl(): string {
        return `${this.opts.secure ? 'wss' : 'ws'}://${this.hostname}${
            this.opts.path || '/'
        }`
    }

    private get apiUrl(): string {
        return `${this.opts.secure ? 'https' : 'http'}://${this.hostname}`
    }

    constructor(opts: Options) {
        super()

        this.opts = {
            ...DEFAULT_OPTS,
            ...opts,
        }

        if (this.opts.url) {
            const url = new URL(this.opts.url)

            this.opts.host = url.hostname
            this.opts.port = Number(url.port)
            this.opts.secure = url.protocol === 'wss:'
            this.opts.path = url.pathname
        }
    }

    public async connect(): Promise<void> {
        const opts = window
            ? undefined
            : {
                  headers: {
                      Authorization: `Bearer ${this.opts.token}`,
                  },
              }

        this.socket = new WebSocket(this.wsUrl, opts)

        const onceOpen = (): Promise<void> => {
            return new Promise((resolve) => {
                const handler = () => {
                    resolve()
                    this.socket.removeEventListener('open', handler)
                }

                this.socket.addEventListener('open', handler)
            })
        }

        this.registerEvents()

        await onceOpen()

        this.reconnectTries = 0
        this.connected = true

        this.emit('connect')
    }

    private registerEvents() {
        this.socket.addEventListener('message', (evt) => {
            const message: Message = JSON.parse(evt.data.toString())

            if (message.status === 200) {
                if (message.action === ACTION_CONNECT) {
                    this.emit('stream-data', message)
                }

                this.resolveCallbacks(message.stream, message.data)
            } else {
                const error = new ClientError(message.status.toString())
                error.msg = message

                this.emit('error', error)
                this.rejectCallbacks(message.stream, error)
            }
        })

        this.socket.addEventListener('error', (err) => {
            this.emit('error', err)
        })

        this.socket.addEventListener('close', (code) => {
            this.connected = false
            this.emit('close', code)

            if (this.opts.autoReconnect && !this.destroyed) {
                setTimeout(() => {
                    if (!this.destroyed) {
                        this.connect()
                    }
                }, ++this.reconnectTries * this.opts.reconnectInterval * this.opts.reconnectIntervalMultiplier)
            }
        })
    }

    private filterCallbacks(handler: (callback: Callback) => boolean) {
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i]

            if (!handler(callback)) {
                this.callbacks.splice(i, 1)
                i--
            }
        }
    }

    private resolveCallbacks(stream: string, data: SessionDescription) {
        this.filterCallbacks((callback) => {
            if (callback.stream === stream) {
                callback.resolve(data)

                return false
            }

            return true
        })
    }

    private rejectCallbacks(stream: string, error: ClientError) {
        this.filterCallbacks((callback) => {
            if (callback.stream === stream) {
                callback.reject(error)

                return false
            }

            return true
        })
    }

    public send(msg: OutgoingMessage): void {
        this.socket.send(JSON.stringify(msg))
    }

    public async createStream(
        name: string,
        allowedHosts?: string[]
    ): Promise<StreamInfo> {
        const authHeader = this.opts.token
            ? `Bearer ${this.opts.token}`
            : undefined

        const res = await fetch(`${this.apiUrl}/streams`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: authHeader,
            },
            body: JSON.stringify({
                name,
                allowedHosts,
            }),
        })

        if (res.status !== 200) {
            throw new Error(`Request returned status code ${res.status}`)
        }

        const body: StreamInfo = await res.json()

        return body
    }

    public watchStream(
        name: string,
        video?: HTMLVideoElement,
        peer?: Instance
    ): Promise<HTMLVideoElement> {
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            if (!this.connected) {
                try {
                    await this.connect()
                } catch (err) {
                    return reject(err)
                }
            }

            this.rejectCallbacks(
                name,
                new ClientError(
                    'Request was cancelled because a new one was made'
                )
            )

            if (!peer) {
                peer = ChakraClient.createPeer({
                    initiator: true,
                    wrtc: this.opts.wrtc,
                })
            }

            if (!video) {
                video = document.createElement('video')
            }

            const stream = name

            peer.addTransceiver('audio', { direction: 'recvonly' })
            peer.addTransceiver('video', { direction: 'recvonly' })

            const onStream = (data: SessionDescription) => peer.signal(data)

            this.callbacks.push({
                stream,
                resolve: onStream,
                reject,
            })

            peer.on('signal', (data: SessionDescription) => {
                if (!data.candidate) {
                    this.send({
                        action: ACTION_CONNECT,
                        stream,
                        data,
                        token: this.opts.token,
                    })
                }
            })

            peer.on('stream', (stream) => {
                const srcObjectSupported = 'srcObject' in video

                if (srcObjectSupported) {
                    video.srcObject = stream
                } else {
                    video.src = window.URL.createObjectURL(stream) // for older browsers
                }

                video.play()
                resolve(video)
            })
        })
    }
}
