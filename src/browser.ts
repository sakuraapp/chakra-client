import SimplePeer, { Options } from 'simple-peer-light'
import * as ChakraClient from './client'

ChakraClient.ChakraClient.createPeer = (opts?: Options) => {
    return new SimplePeer(opts)
}

export = ChakraClient
