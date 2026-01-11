using {CardanoODataService as srv} from './cardano-service';

// ============================================================================
// Annotations for SAP Fiori Elements UI
// ============================================================================

// ----------------------------------------------------------------------------
// NetworkInformation
// ----------------------------------------------------------------------------
annotate srv.NetworkInformation with @(
  UI.HeaderInfo            : {
    TypeName      : 'Network Information',
    TypeNamePlural: 'Network Information',
    Title         : {Value: network}
  },

  UI.SelectionFields       : [network],

  UI.LineItem              : [
    {
      Value: network,
      Label: 'Network'
    },
    {
      Value: maxSupply,
      Label: 'Max Supply'
    },
    {
      Value: totalSupply,
      Label: 'Total Supply'
    },
    {
      Value: circulatingSupply,
      Label: 'Circulating Supply'
    },
    {
      Value: lockedSupply,
      Label: 'Locked Supply'
    },
    {
      Value: treasurySupply,
      Label: 'Treasury Supply'
    },
    {
      Value: reservesSupply,
      Label: 'Reserves Supply'
    },
    {
      Value: liveStake,
      Label: 'Live Stake'
    },
    {
      Value: activeStake,
      Label: 'Active Stake'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetNetworkInformation',
      Label : 'Refresh Network Info'
    }
  ],

  UI.Identification        : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetNetworkInformation',
    Label : 'Refresh Network Info'
  }],

  UI.HeaderFacets          : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Total Supply',
      Target: '@UI.DataPoint#TotalSupply'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Circulating Supply',
      Target: '@UI.DataPoint#Circulating'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Live Stake',
      Target: '@UI.DataPoint#LiveStake'
    }
  ],

  UI.DataPoint #TotalSupply: {
    Value: totalSupply,
    Title: 'Total Supply'
  },
  UI.DataPoint #Circulating: {
    Value: circulatingSupply,
    Title: 'Circulating Supply'
  },
  UI.DataPoint #LiveStake  : {
    Value: liveStake,
    Title: 'Live Stake'
  },

  UI.Facets                : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Supply',
      Target: '@UI.FieldGroup#Supply'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Stake',
      Target: '@UI.FieldGroup#Stake'
    }
  ],

  UI.FieldGroup #Overview  : {Data: [{
    $Type: 'UI.DataField',
    Value: network,
    Label: 'Network'
  }]},

  UI.FieldGroup #Supply    : {Data: [
    {
      $Type: 'UI.DataField',
      Value: maxSupply,
      Label: 'Max Supply'
    },
    {
      $Type: 'UI.DataField',
      Value: totalSupply,
      Label: 'Total Supply'
    },
    {
      $Type: 'UI.DataField',
      Value: circulatingSupply,
      Label: 'Circulating Supply'
    },
    {
      $Type: 'UI.DataField',
      Value: lockedSupply,
      Label: 'Locked Supply'
    },
    {
      $Type: 'UI.DataField',
      Value: treasurySupply,
      Label: 'Treasury Supply'
    },
    {
      $Type: 'UI.DataField',
      Value: reservesSupply,
      Label: 'Reserves Supply'
    }
  ]},

  UI.FieldGroup #Stake     : {Data: [
    {
      $Type: 'UI.DataField',
      Value: liveStake,
      Label: 'Live Stake'
    },
    {
      $Type: 'UI.DataField',
      Value: activeStake,
      Label: 'Active Stake'
    }
  ]}
);


// ----------------------------------------------------------------------------
// Blocks
// ----------------------------------------------------------------------------
annotate srv.Blocks with @(
  UI.HeaderInfo          : {
    TypeName      : 'Block',
    TypeNamePlural: 'Blocks',
    Title         : {Value: hash}
  },

  UI.SelectionFields     : [
    height,
    epochNumber
  ],

  UI.LineItem            : [
    {
      Value: hash,
      Label: 'Hash'
    },
    {
      Value: time,
      Label: 'Time'
    },
    {
      Value: height,
      Label: 'Height'
    },
    {
      Value: slotLeader,
      Label: 'Slot Leader'
    },
    {
      Value: epochNumber,
      Label: 'Epoch Number'
    },
    {
      Value: epochSlot,
      Label: 'Epoch Slot'
    },
    {
      Value: size,
      Label: 'Size'
    },
    {
      Value: txCount,
      Label: 'Tx Count'
    },
    {
      Value: fees,
      Label: 'Fees'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetBlockByHash',
      Label : 'Get Block by Hash'
    }
  ],

  UI.Identification      : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetBlockByHash',
    Label : 'Get Block by Hash'
  }],

  UI.HeaderFacets        : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Height',
      Target: '@UI.DataPoint#Height'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Tx Count',
      Target: '@UI.DataPoint#TxCount'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Fees',
      Target: '@UI.DataPoint#Fees'
    }
  ],

  UI.DataPoint #Height   : {
    Value: height,
    Title: 'Height'
  },
  UI.DataPoint #TxCount  : {
    Value: txCount,
    Title: 'Tx Count'
  },
  UI.DataPoint #Fees     : {
    Value: fees,
    Title: 'Fees'
  },

  UI.Facets              : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Epoch',
      Target: '@UI.FieldGroup#Epoch'
    }
  ],

  UI.FieldGroup #Overview: {Data: [
    {
      $Type: 'UI.DataField',
      Value: hash,
      Label: 'Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: time,
      Label: 'Time'
    },
    {
      $Type: 'UI.DataField',
      Value: height,
      Label: 'Height'
    },
    {
      $Type: 'UI.DataField',
      Value: slotLeader,
      Label: 'Slot Leader'
    },
    {
      $Type: 'UI.DataField',
      Value: size,
      Label: 'Size'
    },
    {
      $Type: 'UI.DataField',
      Value: txCount,
      Label: 'Tx Count'
    },
    {
      $Type: 'UI.DataField',
      Value: fees,
      Label: 'Fees'
    }
  ]},

  UI.FieldGroup #Epoch   : {Data: [
    {
      $Type: 'UI.DataField',
      Value: epochNumber,
      Label: 'Epoch Number'
    },
    {
      $Type: 'UI.DataField',
      Value: epochSlot,
      Label: 'Epoch Slot'
    }
  ]}
);

// ----------------------------------------------------------------------------
// Epochs
// ----------------------------------------------------------------------------
annotate srv.Epochs with @(
  UI.HeaderInfo           : {
    TypeName      : 'Epoch',
    TypeNamePlural: 'Epochs',
    Title         : {Value: epoch}
  },

  UI.SelectionFields      : [epoch],

  UI.LineItem             : [
    {
      Value: epoch,
      Label: 'Epoch'
    },
    {
      Value: startTime,
      Label: 'Start Time'
    },
    {
      Value: endTime,
      Label: 'End Time'
    },
    {
      Value: blockCount,
      Label: 'Block Count'
    },
    {
      Value: txCount,
      Label: 'Tx Count'
    },
    {
      Value: fees,
      Label: 'Fees'
    },
    {
      Value: activeStake,
      Label: 'Active Stake'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetEpochByNumber',
      Label : 'Get Epoch by Number'
    }
  ],

  UI.Identification       : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetEpochByNumber',
    Label : 'Get Epoch by Number'
  }],

  UI.HeaderFacets         : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Blocks',
      Target: '@UI.DataPoint#BlockCount'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Txs',
      Target: '@UI.DataPoint#TxCount'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Fees',
      Target: '@UI.DataPoint#Fees'
    }
  ],

  UI.DataPoint #BlockCount: {
    Value: blockCount,
    Title: 'Block Count'
  },
  UI.DataPoint #TxCount   : {
    Value: txCount,
    Title: 'Tx Count'
  },
  UI.DataPoint #Fees      : {
    Value: fees,
    Title: 'Fees'
  },

  UI.Facets               : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Stake',
      Target: '@UI.FieldGroup#Stake'
    }
  ],

  UI.FieldGroup #Overview : {Data: [
    {
      $Type: 'UI.DataField',
      Value: epoch,
      Label: 'Epoch'
    },
    {
      $Type: 'UI.DataField',
      Value: startTime,
      Label: 'Start Time'
    },
    {
      $Type: 'UI.DataField',
      Value: endTime,
      Label: 'End Time'
    },
    {
      $Type: 'UI.DataField',
      Value: blockCount,
      Label: 'Block Count'
    },
    {
      $Type: 'UI.DataField',
      Value: txCount,
      Label: 'Tx Count'
    },
    {
      $Type: 'UI.DataField',
      Value: fees,
      Label: 'Fees'
    }
  ]},

  UI.FieldGroup #Stake    : {Data: [{
    $Type: 'UI.DataField',
    Value: activeStake,
    Label: 'Active Stake'
  }]}
);

// ----------------------------------------------------------------------------
// Pools
// ----------------------------------------------------------------------------
annotate srv.Pools with @(
  UI.HeaderInfo           : {
    TypeName      : 'Pool',
    TypeNamePlural: 'Pools',
    Title         : {Value: poolId}
  },

  UI.SelectionFields      : [poolId],

  UI.LineItem             : [
    {
      Value: poolId,
      Label: 'Pool ID'
    },
    {
      Value: vrfKeyHash,
      Label: 'VRF Key Hash'
    },
    {
      Value: blocksMinted,
      Label: 'Blocks Minted'
    },
    {
      Value: blocksEpoch,
      Label: 'Blocks This Epoch'
    },
    {
      Value: liveStake,
      Label: 'Live Stake'
    },
    {
      Value: liveSize,
      Label: 'Live Size'
    },
    {
      Value: liveSaturation,
      Label: 'Live Saturation'
    },
    {
      Value: liveDelegators,
      Label: 'Live Delegators'
    },
    {
      Value: activeStake,
      Label: 'Active Stake'
    },
    {
      Value: activeSize,
      Label: 'Active Size'
    },
    {
      Value: pledge,
      Label: 'Pledge'
    },
    {
      Value: margin,
      Label: 'Margin'
    },
    {
      Value: fixedCost,
      Label: 'Fixed Cost'
    },
    {
      Value: rewardAccount,
      Label: 'Reward Account'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetPoolById',
      Label : 'Get Pool by ID'
    }
  ],

  UI.Identification       : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetPoolById',
    Label : 'Get Pool by ID'
  }],

  UI.HeaderFacets         : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Live Stake',
      Target: '@UI.DataPoint#LiveStake'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Pledge',
      Target: '@UI.DataPoint#Pledge'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Delegators',
      Target: '@UI.DataPoint#Delegators'
    }
  ],

  UI.DataPoint #LiveStake : {
    Value: liveStake,
    Title: 'Live Stake'
  },
  UI.DataPoint #Pledge    : {
    Value: pledge,
    Title: 'Pledge'
  },
  UI.DataPoint #Delegators: {
    Value: liveDelegators,
    Title: 'Live Delegators'
  },

  UI.Facets               : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Live',
      Target: '@UI.FieldGroup#Live'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Active',
      Target: '@UI.FieldGroup#Active'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Rewards',
      Target: '@UI.FieldGroup#Rewards'
    }
  ],

  UI.FieldGroup #Overview : {Data: [
    {
      $Type: 'UI.DataField',
      Value: poolId,
      Label: 'Pool ID'
    },
    {
      $Type: 'UI.DataField',
      Value: vrfKeyHash,
      Label: 'VRF Key Hash'
    }
  ]},

  UI.FieldGroup #Live     : {Data: [
    {
      $Type: 'UI.DataField',
      Value: liveStake,
      Label: 'Live Stake'
    },
    {
      $Type: 'UI.DataField',
      Value: liveSize,
      Label: 'Live Size'
    },
    {
      $Type: 'UI.DataField',
      Value: liveSaturation,
      Label: 'Live Saturation'
    },
    {
      $Type: 'UI.DataField',
      Value: liveDelegators,
      Label: 'Live Delegators'
    }
  ]},

  UI.FieldGroup #Active   : {Data: [
    {
      $Type: 'UI.DataField',
      Value: activeStake,
      Label: 'Active Stake'
    },
    {
      $Type: 'UI.DataField',
      Value: activeSize,
      Label: 'Active Size'
    },
    {
      $Type: 'UI.DataField',
      Value: blocksMinted,
      Label: 'Blocks Minted'
    },
    {
      $Type: 'UI.DataField',
      Value: blocksEpoch,
      Label: 'Blocks This Epoch'
    }
  ]},

  UI.FieldGroup #Rewards  : {Data: [
    {
      $Type: 'UI.DataField',
      Value: pledge,
      Label: 'Pledge'
    },
    {
      $Type: 'UI.DataField',
      Value: margin,
      Label: 'Margin'
    },
    {
      $Type: 'UI.DataField',
      Value: fixedCost,
      Label: 'Fixed Cost'
    },
    {
      $Type: 'UI.DataField',
      Value: rewardAccount,
      Label: 'Reward Account'
    }
  ]}
);

// ----------------------------------------------------------------------------
// Dreps
// ----------------------------------------------------------------------------
annotate srv.Dreps with @(
  UI.HeaderInfo            : {
    TypeName      : 'DRep',
    TypeNamePlural: 'DReps',
    Title         : {Value: drepId}
  },

  // List Report filter
  UI.SelectionFields       : [drepId],

  // List Report table
  UI.LineItem              : [
    {
      Value: drepId,
      Label: 'DRep ID'
    },
    {
      Value: amount,
      Label: 'Voting Power'
    },
    {
      Value: hasScript,
      Label: 'Has Script'
    },
    {
      Value: lastActiveEpoch,
      Label: 'Last Active Epoch'
    },
    {
      Value: retired,
      Label: 'Retired'
    },
    {
      Value: expired,
      Label: 'Expired'
    },

    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetDrepById',
      Label : 'Get DRep by ID'
    }
  ],

  UI.Identification        : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetDrepById',
    Label : 'Get DRep by ID'
  }],

  UI.HeaderFacets          : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Voting Power',
    Target: '@UI.DataPoint#VotingPower'
  }],

  UI.DataPoint #VotingPower: {
    Value: amount,
    Title: 'Voting Power'
  },

  // Object Page: clean sections
  UI.Facets                : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Status',
      Target: '@UI.FieldGroup#Status'
    }
  ],

  UI.FieldGroup #Overview  : {Data: [
    {
      $Type: 'UI.DataField',
      Value: drepId,
      Label: 'DRep ID'
    },
    {
      $Type: 'UI.DataField',
      Value: hex,
      Label: 'Hex'
    }
  ]},

  UI.FieldGroup #Status    : {Data: [
    {
      $Type: 'UI.DataField',
      Value: hasScript,
      Label: 'Has Script'
    },
    {
      $Type: 'UI.DataField',
      Value: lastActiveEpoch,
      Label: 'Last Active Epoch'
    },
    {
      $Type: 'UI.DataField',
      Value: retired,
      Label: 'Retired'
    },
    {
      $Type: 'UI.DataField',
      Value: expired,
      Label: 'Expired'
    }
  ]}
);

// Provide consistent labels everywhere (List + Object Page)
annotate srv.Dreps with {
  drepId          @Common.Label: 'DRep ID';
  hex             @Common.Label: 'Hex';
  amount          @Common.Label: 'Voting Power (Lovelace)';
  hasScript       @Common.Label: 'Has Script';
  lastActiveEpoch @Common.Label: 'Last Active Epoch';
  retired         @Common.Label: 'Retired';
  expired         @Common.Label: 'Expired';
};

// ----------------------------------------------------------------------------
// Addresses & related Assets + UTxOs
// ----------------------------------------------------------------------------
annotate srv.Addresses with @(
  UI.HeaderInfo                : {
    TypeName      : 'Address',
    TypeNamePlural: 'Addresses',
    Title         : {Value: address}
  },

  UI.SelectionFields           : [
    address,
    type
  ],

  UI.LineItem                  : [
    {
      Value: address,
      Label: 'Address'
    },
    {
      Value: stakeAddress,
      Label: 'Stake Address'
    },
    {
      Value: type,
      Label: 'Type'
    },
    {
      Value: isScript,
      Label: 'Is Script'
    },
    {
      Value: totalLovelace,
      Label: 'Total Lovelace'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetAddressByBech32',
      Label : 'Get Address by Bech32'
    }
  ],

  UI.Identification            : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetAddressByBech32',
    Label : 'Get Address by Bech32'
  }],

  UI.HeaderFacets              : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Total Lovelace',
    Target: '@UI.DataPoint#TotalLovelace'
  }],

  UI.DataPoint #TotalLovelace  : {
    Value: totalLovelace,
    Title: 'Total Lovelace'
  },

  UI.Facets                    : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Account Details',
      Target: '@UI.FieldGroup#AccountDetails'
    },

    // existing navigations preserved
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

  UI.FieldGroup #Overview      : {Data: [
    {
      $Type: 'UI.DataField',
      Value: address,
      Label: 'Address'
    },
    {
      $Type: 'UI.DataField',
      Value: stakeAddress,
      Label: 'Stake Address'
    },
    {
      $Type: 'UI.DataField',
      Value: type,
      Label: 'Type'
    },
    {
      $Type: 'UI.DataField',
      Value: isScript,
      Label: 'Is Script'
    },
    {
      $Type: 'UI.DataField',
      Value: totalLovelace,
      Label: 'Total Lovelace'
    }
  ]},

  UI.FieldGroup #AccountDetails: {Data: [{
    $Type: 'UI.DataField',
    Value: stakeAddress,
    Label: 'Stake Address'
  }]}
);

annotate srv.AddressAssets with @(
  UI.HeaderInfo              : {
    TypeName      : 'Address Asset',
    TypeNamePlural: 'Address Assets',
    Title         : {Value: unit}
  },

  UI.LineItem                : [
    {
      Value: unit,
      Label: 'Unit'
    },
    {
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ],

  UI.HeaderFacets            : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Quantity',
    Target: '@UI.DataPoint#Quantity'
  }],

  UI.DataPoint #Quantity     : {
    Value: asset_quantity,
    Title: 'Quantity'
  },

  UI.Facets                  : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Asset Details',
    Target: '@UI.FieldGroup#AssetDetails'
  }],

  UI.FieldGroup #AssetDetails: {Data: [
    {
      $Type: 'UI.DataField',
      Value: unit,
      Label: 'Unit'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetNameHex,
      Label: 'Asset Name (Hex)'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ]}
);

annotate srv.AddressUTxOs with @(
  UI.HeaderInfo             : {
    TypeName      : 'Address UTxO',
    TypeNamePlural: 'Address UTxOs',
    Title         : {Value: hash},
    Description   : {Value: index}
  },

  UI.LineItem               : [
    {
      Value: hash,
      Label: 'Transaction Hash'
    },
    {
      Value: index,
      Label: 'Output Index'
    },
    {
      Value: blockHash,
      Label: 'Block Hash'
    },
    {
      Value: utxodata_dataHash,
      Label: 'Data Hash'
    },
    {
      Value: hasAssets,
      Label: 'Has Assets'
    }
  ],

  UI.HeaderFacets           : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'UTxO Index',
      Target: '@UI.DataPoint#Index'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Has Assets',
      Target: '@UI.DataPoint#HasAssets'
    }
  ],

  UI.DataPoint #Index       : {
    Value: index,
    Title: 'UTxO Index'
  },
  UI.DataPoint #HasAssets   : {
    Value: hasAssets,
    Title: 'Has Assets'
  },

  UI.Facets                 : [
    {
      $Type        : 'UI.ReferenceFacet',
      Label        : 'Assets',
      Target       : 'assets/@UI.LineItem',
      ![@UI.Hidden]: (not hasAssets)
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'UTxO Details',
      Target: '@UI.FieldGroup#UTxODetails'
    }
  ],

  UI.FieldGroup #UTxODetails: {Data: [
    {
      $Type: 'UI.DataField',
      Value: hash,
      Label: 'Transaction Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: index,
      Label: 'Output Index'
    },
    {
      $Type: 'UI.DataField',
      Value: blockHash,
      Label: 'Block Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: utxodata_dataHash,
      Label: 'Data Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: utxodata_inlineDatum,
      Label: 'Inline Datum'
    },
    {
      $Type: 'UI.DataField',
      Value: utxodata_referenceScriptHash,
      Label: 'Reference Script Hash'
    }
  ]}
);

annotate srv.UTxOAssets with @(
  UI.HeaderInfo              : {
    TypeName      : 'UTxO Asset',
    TypeNamePlural: 'UTxO Assets',
    Title         : {Value: unit}
  },

  UI.LineItem                : [
    {
      Value: unit,
      Label: 'Unit'
    },
    {
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ],

  UI.HeaderFacets            : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Quantity',
    Target: '@UI.DataPoint#Quantity'
  }],

  UI.DataPoint #Quantity     : {
    Value: asset_quantity,
    Title: 'Quantity'
  },

  UI.Facets                  : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Asset Details',
    Target: '@UI.FieldGroup#AssetDetails'
  }],

  UI.FieldGroup #AssetDetails: {Data: [
    {
      $Type: 'UI.DataField',
      Value: unit,
      Label: 'Unit'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetNameHex,
      Label: 'Asset Name (Hex)'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ]}
);


// ----------------------------------------------------------------------------
// Transactions
// ----------------------------------------------------------------------------
annotate srv.Transactions with @(
  UI.HeaderInfo          : {
    TypeName      : 'Transaction',
    TypeNamePlural: 'Transactions',
    Title         : {Value: hash},
    Description   : {Value: blockTime}
  },

  UI.SelectionFields     : [
    hash,
    blockHeight
  ],

  UI.LineItem            : [
    {
      Value: hash,
      Label: 'Hash'
    },
    {
      Value: blockHeight,
      Label: 'Block Height'
    },
    {
      Value: blockTime,
      Label: 'Block Time'
    },
    {
      Value: slot,
      Label: 'Slot'
    },
    {
      Value: txIndex,
      Label: 'Tx Index'
    },
    {
      Value: fee,
      Label: 'Fee'
    },
    {
      Value: deposit,
      Label: 'Deposit'
    },
    {
      Value: size,
      Label: 'Size'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetTransactionByHash',
      Label : 'Get Transaction by Hash'
    }
  ],

  UI.Identification      : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetTransactionByHash',
    Label : 'Get Transaction by Hash'
  }],

  UI.HeaderFacets        : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Fee',
      Target: '@UI.DataPoint#Fee'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Deposit',
      Target: '@UI.DataPoint#Deposit'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Size',
      Target: '@UI.DataPoint#Size'
    }
  ],

  UI.DataPoint #Fee      : {
    Value: fee,
    Title: 'Fee'
  },
  UI.DataPoint #Deposit  : {
    Value: deposit,
    Title: 'Deposit'
  },
  UI.DataPoint #Size     : {
    Value: size,
    Title: 'Size'
  },

  UI.Facets              : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },

    // existing navigations preserved
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
  ],

  UI.FieldGroup #Overview: {Data: [
    {
      $Type: 'UI.DataField',
      Value: hash,
      Label: 'Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: blockHash,
      Label: 'Block Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: blockHeight,
      Label: 'Block Height'
    },
    {
      $Type: 'UI.DataField',
      Value: blockTime,
      Label: 'Block Time'
    },
    {
      $Type: 'UI.DataField',
      Value: slot,
      Label: 'Slot'
    },
    {
      $Type: 'UI.DataField',
      Value: txIndex,
      Label: 'Tx Index'
    },
    {
      $Type: 'UI.DataField',
      Value: fee,
      Label: 'Fee'
    },
    {
      $Type: 'UI.DataField',
      Value: deposit,
      Label: 'Deposit'
    },
    {
      $Type: 'UI.DataField',
      Value: size,
      Label: 'Size'
    }
  ]}
);

// ----------------------------------------------------------------------------
// Transaction Metadata
// ----------------------------------------------------------------------------
annotate srv.TransactionMetadata with @(UI.LineItem: [
  {
    Value: label,
    Label: 'Label'
  },
  {
    Value: payload,
    Label: 'Payload'
  }
]);
// ----------------------------------------------------------------------------
// Transaction Inputs & Inputs Assets
// ----------------------------------------------------------------------------

annotate srv.TransactionInputs with @(
  UI.HeaderInfo           : {
    TypeName      : 'Transaction Input',
    TypeNamePlural: 'Transaction Inputs',
    Title         : {Value: inputIndex},
    Description   : {Value: address_address}
  },

  UI.LineItem             : [
    {
      Value: inputIndex,
      Label: 'Input Index'
    },
    {
      Value: address_address,
      Label: 'Address'
    },
    {
      Value: utxoData_dataHash,
      Label: 'Data Hash'
    },
    {
      Value: isCollateral,
      Label: 'Is Collateral'
    },
    {
      Value: isReference,
      Label: 'Is Reference'
    },
    {
      Value: hasAssets,
      Label: 'Has Assets'
    }
  ],

  UI.PresentationVariant  : {Visualizations: ['@UI.LineItem']},

  UI.HeaderFacets         : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Input Index',
      Target: '@UI.DataPoint#InputIndex'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Has Assets',
      Target: '@UI.DataPoint#HasAssets'
    }
  ],

  UI.DataPoint #InputIndex: {
    Value: inputIndex,
    Title: 'Input Index'
  },
  UI.DataPoint #HasAssets : {
    Value: hasAssets,
    Title: 'Has Assets'
  },

  UI.Facets               : [
    {
      $Type        : 'UI.ReferenceFacet',
      Label        : 'Assets',
      Target       : 'assets/@UI.LineItem',
      ![@UI.Hidden]: (not hasAssets)
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Details',
      Target: '@UI.FieldGroup#Details'
    }
  ],

  UI.FieldGroup #Details  : {Data: [
    {
      $Type: 'UI.DataField',
      Value: inputIndex,
      Label: 'Input Index'
    },
    {
      $Type: 'UI.DataField',
      Value: address_address,
      Label: 'Address'
    },
    {
      $Type: 'UI.DataField',
      Value: utxoData_dataHash,
      Label: 'Data Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: utxoData_inlineDatum,
      Label: 'Inline Datum'
    },
    {
      $Type: 'UI.DataField',
      Value: utxoData_referenceScriptHash,
      Label: 'Reference Script Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: isCollateral,
      Label: 'Is Collateral'
    },
    {
      $Type: 'UI.DataField',
      Value: isReference,
      Label: 'Is Reference'
    }
  ]}
);

annotate srv.TransactionInputAssets with @(
  UI.HeaderInfo              : {
    TypeName      : 'Input Asset',
    TypeNamePlural: 'Input Assets',
    Title         : {Value: unit}
  },

  UI.LineItem                : [
    {
      Value: unit,
      Label: 'Unit'
    },
    {
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ],

  UI.Facets                  : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Asset Details',
    Target: '@UI.FieldGroup#AssetDetails'
  }],

  UI.FieldGroup #AssetDetails: {Data: [
    {
      $Type: 'UI.DataField',
      Value: unit,
      Label: 'Unit'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetNameHex,
      Label: 'Asset Name (Hex)'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ]}
);

// ----------------------------------------------------------------------------
// Transaction Outputs & Output Assets
// ----------------------------------------------------------------------------

annotate srv.TransactionOutputs with @(
  UI.HeaderInfo            : {
    TypeName      : 'Transaction Output',
    TypeNamePlural: 'Transaction Outputs',
    Title         : {Value: outputIndex},
    Description   : {Value: address_address}
  },

  UI.PresentationVariant   : {Visualizations: ['@UI.LineItem']},

  UI.LineItem              : [
    {
      Value: outputIndex,
      Label: 'Output Index'
    },
    {
      Value: address_address,
      Label: 'Address'
    },
    {
      Value: hasAssets,
      Label: 'Has Assets'
    }
  ],

  UI.HeaderFacets          : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Output Index',
      Target: '@UI.DataPoint#OutputIndex'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Has Assets',
      Target: '@UI.DataPoint#HasAssets'
    }
  ],

  UI.DataPoint #OutputIndex: {
    Value: outputIndex,
    Title: 'Output Index'
  },
  UI.DataPoint #HasAssets  : {
    Value: hasAssets,
    Title: 'Has Assets'
  },

  UI.Facets                : [
    {
      $Type        : 'UI.ReferenceFacet',
      Label        : 'Assets',
      Target       : 'assets/@UI.LineItem',
      ![@UI.Hidden]: (not hasAssets)
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Details',
      Target: '@UI.FieldGroup#Details'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'UTxO Data',
      Target: '@UI.FieldGroup#UTxOData'
    }
  ],

  UI.FieldGroup #Details   : {Data: [
    {
      $Type: 'UI.DataField',
      Value: outputIndex,
      Label: 'Output Index'
    },
    {
      $Type: 'UI.DataField',
      Value: address_address,
      Label: 'Address'
    },
    {
      $Type: 'UI.DataField',
      Value: hasAssets,
      Label: 'Has Assets'
    }
  ]},

  UI.FieldGroup #UTxOData  : {Data: [
    {
      $Type: 'UI.DataField',
      Value: utxo_dataHash,
      Label: 'Data Hash'
    },
    {
      $Type: 'UI.DataField',
      Value: utxo_inlineDatum,
      Label: 'Inline Datum'
    },
    {
      $Type: 'UI.DataField',
      Value: utxo_referenceScriptHash,
      Label: 'Reference Script Hash'
    }
  ]}
);

annotate srv.TransactionOutputAssets with @(
  UI.HeaderInfo              : {
    TypeName      : 'Output Asset',
    TypeNamePlural: 'Output Assets',
    Title         : {Value: unit},
    Description   : {Value: asset_assetName}
  },

  UI.LineItem                : [
    {
      Value: unit,
      Label: 'Unit'
    },
    {
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ],

  UI.Facets                  : [{
    $Type : 'UI.ReferenceFacet',
    Label : 'Asset Details',
    Target: '@UI.FieldGroup#AssetDetails'
  }],

  UI.FieldGroup #AssetDetails: {Data: [
    {
      $Type: 'UI.DataField',
      Value: unit,
      Label: 'Unit'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_quantity,
      Label: 'Quantity'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_policyId,
      Label: 'Policy ID'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetNameHex,
      Label: 'Asset Name (Hex)'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_assetName,
      Label: 'Asset Name'
    },
    {
      $Type: 'UI.DataField',
      Value: asset_fingerprint,
      Label: 'Fingerprint'
    }
  ]}
);


// ----------------------------------------------------------------------------
// Accounts
// ----------------------------------------------------------------------------
annotate srv.Accounts with @(
  UI.HeaderInfo             : {
    TypeName      : 'Account',
    TypeNamePlural: 'Accounts',
    Title         : {Value: stakeAddress}
  },

  UI.SelectionFields        : [stakeAddress],

  UI.LineItem               : [
    {
      Value: stakeAddress,
      Label: 'Stake Address'
    },
    {
      Value: active,
      Label: 'Active'
    },
    {
      Value: activeEpoch,
      Label: 'Active Epoch'
    },
    {
      Value: controlledAmount,
      Label: 'Controlled Amount'
    },
    {
      Value: rewardsSum,
      Label: 'Rewards Sum'
    },
    {
      Value: withdrawalsSum,
      Label: 'Withdrawals Sum'
    },
    {
      Value: reservesSum,
      Label: 'Reserves Sum'
    },
    {
      Value: treasurySum,
      Label: 'Treasury Sum'
    },
    {
      Value: withdrawableAmount,
      Label: 'Withdrawable Amount'
    },
    {
      Value: poolId_poolId,
      Label: 'Pool ID'
    },
    {
      Value: drepId_drepId,
      Label: 'DRep ID'
    },
    {
      Value: hasAddresses,
      Label: 'Has Addresses'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'CardanoODataService.EntityContainer/GetAccountByStakeAddress',
      Label : 'Get Account by Stake Address'
    }
  ],

  UI.Identification         : [{
    $Type : 'UI.DataFieldForAction',
    Action: 'CardanoODataService.EntityContainer/GetAccountByStakeAddress',
    Label : 'Get Account by Stake Address'
  }],

  UI.HeaderFacets           : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Controlled',
      Target: '@UI.DataPoint#Controlled'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Withdrawable',
      Target: '@UI.DataPoint#Withdrawable'
    }
  ],

  UI.DataPoint #Controlled  : {
    Value: controlledAmount,
    Title: 'Controlled Amount'
  },
  UI.DataPoint #Withdrawable: {
    Value: withdrawableAmount,
    Title: 'Withdrawable Amount'
  },

  UI.Facets                 : [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Overview',
      Target: '@UI.FieldGroup#Overview'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'Sums',
      Target: '@UI.FieldGroup#Sums'
    },

    {
      $Type        : 'UI.ReferenceFacet',
      Label        : 'Addresses',
      Target       : 'Address/@UI.LineItem',
      ![@UI.Hidden]: (not hasAddresses)
    }
  ],

  UI.FieldGroup #Overview   : {Data: [
    {
      $Type: 'UI.DataField',
      Value: stakeAddress,
      Label: 'Stake Address'
    },
    {
      $Type: 'UI.DataField',
      Value: active,
      Label: 'Active'
    },
    {
      $Type: 'UI.DataField',
      Value: activeEpoch,
      Label: 'Active Epoch'
    },
    {
      $Type: 'UI.DataField',
      Value: poolId_poolId,
      Label: 'Pool ID'
    },
    {
      $Type: 'UI.DataField',
      Value: drepId_drepId,
      Label: 'DRep ID'
    },
    {
      $Type: 'UI.DataField',
      Value: hasAddresses,
      Label: 'Has Addresses'
    }
  ]},

  UI.FieldGroup #Sums       : {Data: [
    {
      $Type: 'UI.DataField',
      Value: controlledAmount,
      Label: 'Controlled Amount'
    },
    {
      $Type: 'UI.DataField',
      Value: rewardsSum,
      Label: 'Rewards Sum'
    },
    {
      $Type: 'UI.DataField',
      Value: withdrawalsSum,
      Label: 'Withdrawals Sum'
    },
    {
      $Type: 'UI.DataField',
      Value: reservesSum,
      Label: 'Reserves Sum'
    },
    {
      $Type: 'UI.DataField',
      Value: treasurySum,
      Label: 'Treasury Sum'
    },
    {
      $Type: 'UI.DataField',
      Value: withdrawableAmount,
      Label: 'Withdrawable Amount'
    }
  ]}
);
