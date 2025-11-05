# XChain Platform Encoder

## Overview
A JavaScript module for encoding data within xchain-compatible blockchain transactions.

## JSON RPC API Reference

### `create_tx` Function
Constructs a transaction with embedded data.

#### Parameters
| Parameter          | Type                                   | Description                                                                 | Required | Default       |
|--------------------|----------------------------------------|-----------------------------------------------------------------------------|----------|---------------|
| `utxosList`        | `Array<UTXO>`                          | List of UTXOs to spend (see structure below)                                | No <sup>[1](#utxolist-footnote)</sup>      | -             |
| `pubkey`           | `string`                               | Sender's public key (hex)                                                   | Yes      | -             |
| `customOutputs`    | `Array<{address: string, value: number}>` | Custom outputs                                                           | No       | `[]`          |
| `data`             | `string \| Buffer`                     | Data to embed (hex/Buffer)                                                  | Yes      |               |
| `rawData`          | `string \| Buffer`                     | Additional Data to embed that will be ignored by the decoder (hex/Buffer)   | No       | `null`        |
| `exactFee`         | `number`                               | Fixed fee in satoshis                                                       | No       | Auto-calculated|
| `rbf`              | `boolean`                              | Enable Replace-By-Fee                                                       | No       | `false`       |
| `outputType`       | `string`                               | Encoding type (`op_return`/`p2sh`/`p2wsh`/`p2tr`/`multisign`)               | No       |`op_return`/`p2sh`|
| `changeAddress`    | `string`                               | Change address                                                              | No       | -             |
| `p2shHash`         | `string`                               | previous P2SH redeem script hash                                            | No       | -             |
| `p2shHex`          | `string`                               | previous P2SH hex                                                           | No       | -             |
| `compressedPubKey` | `boolean`                              | Compressed pubkey for multisign                                             | No       | null        |

#### Footnotes
<a name="utxolist-footnote">1</a>: `utxosList` is not required if the `UTXO_TRACKER_URL` environment variable is configured and the UTXO Tracker service is reachable. If omitted, the module will automatically fetch UTXOs for the provided `pubkey`.

#### UTXO Structure
```javascript
{
  txid: "hexstring",  // Transaction ID 
  vout: 0,            // Output index
  value: 100000,      // Value in satoshis
  scriptPubKey: "hex" // Locking script
}
```

#### Returns
- **`psbtHex`**:  
  - Hex-encoded PSBT compliant with [BIP 174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki).

---

## Environment Variables & Deployment

### **1. Core Configuration**
| Variable               | Required | Default      | Description                                                                 |
|------------------------|----------|--------------|-----------------------------------------------------------------------------|
| `NETWORK`              | Yes      |              | Coin and network (`bitcoin-mainnet`, `dogecoin-testnet`, `bitcoin-regtest`) |
| `ENCODER_API_PORT`     | No       | `3000`       | Port for the encoder's JSON-RPC API                                         |

### **2. Bitcoin Node Connection**
| Variable               | Required | Default      | Description                                                                 |
|------------------------|----------|--------------|-----------------------------------------------------------------------------|
| `NODE_URL`             | Yes      | -            | Bitcoin Core RPC host (e.g., `127.0.0.1`)                                  |
| `NODE_PORT`            | Yes      | -            | Bitcoin Core RPC port (`8332` for mainnet, `18332` for testnet)            |
| `NODE_USER`            | Yes      | -            | RPC username                                                               |
| `NODE_PASSWORD`        | Yes      | -            | RPC password                                                               |

### **3. UTXO Tracker Integration**
| Variable               | Required | Default      | Description                                                                 |
|------------------------|----------|--------------|-----------------------------------------------------------------------------|
| `UTXO_TRACKER_URL`     | No       | -            | Host of the Xchain UTXO Tracker API                                         |
| `UTXO_TRACKER_API_PORT`| No       | -            | Port for the Xchain UTXO Tracker API                                        |

---

### **Deployment Options**

#### **A. Docker Deployment**
```bash
docker build -t xchain-encoder .
docker run -d \
  -e NETWORK=bitcoin-testnet \
  -e NODE_URL=bitcoind \
  -e NODE_PORT=18332 \
  -e NODE_USER=rpcuser \
  -e NODE_PASSWORD=rpcpass \
  -e UTXO_TRACKER_URL=utxo-tracker \
  -e ENCODER_API_PORT=3000 \
  -p 3000:3000 \
  --name xchain-encoder \
  xchain-encoder
```

#### **B. Browser Bundle**
```bash
# Development build (unminified)
npm run build:dev  # Output: ./dist/xchain-encoder.js

# Production build (minified)
npm run build      # Output: ./dist/xchain-encoder.min.js
```

---

**Copyright © 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC – https://dankest.llc**  

Licensed under the **Dankest Community License**  
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).  

You may not use, modify, or distribute this material except in compliance with the License.  
A full copy of the License is available at: [https://dankest.llc/license](https://dankest.llc/license)

---