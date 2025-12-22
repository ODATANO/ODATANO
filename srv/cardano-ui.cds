using {CardanoODataService as srv} from './cardano-service';

// ============================================================================
// Annotations for SAP Fiori Elements UI
// ============================================================================

// ----------------------------------------------------------------------------
// NetworkInformation
// ----------------------------------------------------------------------------
annotate srv.NetworkInformation with @(
    UI.HeaderInfo     : {
        TypeName      : 'Network Information',
        TypeNamePlural: 'Network Information',
        Title         : {Value: network}
    },
    UI.SelectionFields: [network],
    UI.LineItem       : [
        {Value: network},
        {Value: maxSupply},
        {Value: totalSupply},
        {Value: circulatingSupply},
        {Value: lockedSupply},
        {Value: treasurySupply},
        {Value: reservesSupply},
        {Value: liveStake},
        {Value: activeStake},

        {
            $Type : 'UI.DataFieldForAction',
            Action: 'CardanoODataService.EntityContainer/GetNetworkInformation',
            Label : 'Refresh Network Info'
        }
    ]
);

// ----------------------------------------------------------------------------
// Blocks
// ----------------------------------------------------------------------------
annotate srv.Blocks with @(
    UI.HeaderInfo     : {
        TypeName      : 'Block',
        TypeNamePlural: 'Blocks',
        Title         : {Value: hash}
    },
    UI.SelectionFields: [
        height,
        epochNumber
    ],
    UI.LineItem       : [
        {Value: hash},
        {Value: time},
        {Value: height},
        {Value: slotLeader},
        {Value: epochNumber},
        {Value: epochSlot},
        {Value: size},
        {Value: txCount},
        {Value: fees},

        {
            $Type : 'UI.DataFieldForAction',
            Action: 'CardanoODataService.EntityContainer/GetLatestBlock',
            Label : 'Refresh Latest Block'
        },

        {
            $Type : 'UI.DataFieldForAction',
            action: 'CardanoODataService.EntityContainer/GetBlockByHash',
            Label : 'Get Block by Hash'
        }
    ]
);

// ----------------------------------------------------------------------------
// LatestEpoch – nur Epoch- und Netzwerk-Refresh
// ----------------------------------------------------------------------------
annotate srv.Epochs with @(
    UI.HeaderInfo     : {
        TypeName      : 'Epoch',
        TypeNamePlural: 'Epochs',
        Title         : {Value: epoch}
    },
    UI.SelectionFields: [epoch],
    UI.LineItem       : [
        {Value: epoch},
        {Value: startTime},
        {Value: endTime},
        {Value: blockCount},
        {Value: txCount},
        {Value: fees},
        {Value: activeStake},

        {
            $Type : 'UI.DataFieldForAction',
            Action: 'CardanoODataService.EntityContainer/GetLatestEpoch',
            Label : 'Refresh Latest Epoch'
        },
        {
            $Type : 'UI.DataFieldForAction',
            Action: 'CardanoODataService.EntityContainer/GetEpochByNumber',
            Label : 'Get Epoch by Number'
        },

    ]
);

// ----------------------------------------------------------------------------
// Addresses – nur Address-bezogene Actions + Netzwerk-Refresh
// ----------------------------------------------------------------------------
annotate srv.Addresses with @(
    UI.HeaderInfo     : {
        TypeName      : 'Address',
        TypeNamePlural: 'Addresses',
        Title         : {Value: address}
    },
    UI.SelectionFields: [
        address,
        type
    ],
    UI.LineItem       : [
        {Value: address},
        {Value: stakeAddress},
        {Value: type},
        {Value: isScript},
        {Value: totalLovelace},

        {
            $Type : 'UI.DataFieldForAction',
            Action: 'CardanoODataService.EntityContainer/GetAddressByBech32',
            Label : 'Get Address by Bech32'
        }
    ],
    UI.Facets         : [
        {
            $Type        : 'UI.ReferenceFacet',
            Label        : 'Assets',
            Target       : 'assets/@UI.LineItem',
            ![@UI.Hidden]: (not hasAssets)
        },
        {
            $Type        : 'UI.ReferenceFacet',
            Label        : 'UTxOs',
            Target       : 'utxos/@UI.LineItem',
            ![@UI.Hidden]: (not hasUTxOs)
        }
    ],
);

// ----------------------------------------------------------------------------
// Transactions – nur Transaction-bezogene Actions + Netzwerk-Refresh
// ----------------------------------------------------------------------------
annotate srv.Transactions with @(
    UI.HeaderInfo     : {
        TypeName      : 'Transaction',
        TypeNamePlural: 'Transactions',
        Title         : {Value: hash},
        Description   : {Value: blockTime}
    },
    UI.SelectionFields: [hash],
    UI.LineItem       : [
        {Value: hash},
        {Value: blockHeight},
        {Value: blockTime},
        {Value: fee},
        {Value: size},
        {Value: validContract},
        {Value: assetMintOrBurnCount},
        {Value: redeemerCount},

        {
            $Type : 'UI.DataFieldForAction',
            Action: 'CardanoODataService.EntityContainer/GetTransactionByHash',
            Label : 'Get Transaction by Hash'
        }
    ],
    UI.Facets         : [
        {
            $Type        : 'UI.ReferenceFacet',
            Label        : 'Metadata',
            Target       : 'metadata/@UI.LineItem',
            ![@UI.Hidden]: (not hasMetadata)
        },
        {
            $Type        : 'UI.ReferenceFacet',
            Label        : 'Inputs',
            Target       : 'inputs/@UI.LineItem',
            ![@UI.Hidden]: (not hasInputs)
        },
        {
            $Type        : 'UI.ReferenceFacet',
            Label        : 'Outputs',
            Target       : 'outputs/@UI.LineItem',
            ![@UI.Hidden]: (not hasOutputs)
        }
    ]
);

annotate srv.AddressAssets with @UI.LineItem: [
    {Value: unit},
    {Value: asset.quantity},
    {Value: asset.policyId},
    {Value: asset.assetName},
    {Value: asset.fingerprint}
];

annotate srv.AddressUTxOs with @UI.LineItem: [
    {Value: hash},
    {Value: index},
    {Value: blockHash},
    {Value: utxodata.dataHash}
];

annotate srv.UTxOAssets with @UI.LineItem: [
    {Value: unit},
    {Value: asset.quantity},
    {Value: asset.policyId},
    {Value: asset.assetName},
    {Value: asset.fingerprint}
];

annotate srv.TransactionMetadata with @UI.LineItem: [
    {Value: label},
    {Value: payload}
];

annotate srv.TransactionInputs with @UI.LineItem: [
    {Value: inputIndex},
    {Value: address.address},
    {Value: dataHash},
    {Value: isCollateral},
    {Value: isReference}
];

annotate srv.TransactionInputAssets with @UI.LineItem: [
    {Value: unit},
    {Value: asset.quantity},
    {Value: asset.policyId},
    {Value: asset.assetName}
];

annotate srv.TransactionOutputs with @UI.LineItem: [
    {Value: outputIndex},
    {Value: address.address},
    {Value: dataHash}
];

annotate srv.TransactionOutputAssets with @UI.LineItem: [
    {Value: unit},
    {Value: asset.quantity},
    {Value: asset.policyId},
    {Value: asset.assetName}
];

// ----------------------------------------------------------------------------
// Pools
// ----------------------------------------------------------------------------
annotate srv.Pools with @(
    UI.HeaderInfo     : {
        TypeName      : 'Pool',
        TypeNamePlural: 'Pools',
        Title         : {Value: poolId}
    },
    UI.SelectionFields: [poolId],
    UI.LineItem       : [
        {Value: poolId},
        {Value: vrfKeyHash},
        {Value: blocksMinted},
        {Value: blocksEpoch},
        {Value: liveStake},
        {Value: liveSize},
        {Value: liveSaturation},
        {Value: liveDelegators},
        {Value: activeStake},
        {Value: activeSize},
        {Value: pledge},
        {Value: margin},
        {Value: fixedCost},
        {Value: rewardAccount}
    ]
);


// ----------------------------------------------------------------------------
// Dreps
// ----------------------------------------------------------------------------
annotate srv.Dreps with @(
    UI.HeaderInfo     : {
        TypeName      : 'DRep',
        TypeNamePlural: 'DReps',
        Title         : {Value: drepId}
    },
    UI.SelectionFields: [drepId],
    UI.LineItem       : [
        {Value: drepId},
        {Value: hex},
        {Value: amount},
        {Value: hasScript},
        {Value: lastActiveEpoch},
        {Value: retired},
        {Value: expired}
    ]
);

// ----------------------------------------------------------------------------
// Accounts
// ----------------------------------------------------------------------------
annotate srv.Accounts with @(
    UI.HeaderInfo     : {
        TypeName      : 'Account',
        TypeNamePlural: 'Accounts',
        Title         : {Value: account_id}
    },
    UI.SelectionFields: [account_id],
    UI.LineItem       : [
        {Value: stakeAddress},
        {Value: active},
        {Value: activeEpoch},
        {Value: controlledAmount},
        {Value: rewardsSum},
        {Value: withdrawalsSum},
        {Value: reservesSum},
        {Value: treasurySum},
        {Value: withdrawableAmount},
        {Value: poolId},
        {Value: drepId},
        {Value: hasAddresses}
    ]
);
