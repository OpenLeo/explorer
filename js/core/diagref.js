// Built-in minimal diagnostic reference (public ISO 14229 / ISO 14230 / SAE J1979 identifiers),
// used when the repository has no diag/protocols/*.yml yet, and to describe requests.

export const UDS_SERVICES = {
  0x10: ['DiagnosticSessionControl', 'SID SUBFN'], 0x11: ['ECUReset', 'SID SUBFN'], 0x14: ['ClearDiagnosticInformation', 'SID GROUP(3)'],
  0x19: ['ReadDTCInformation', 'SID SUBFN ...'], 0x22: ['ReadDataByIdentifier', 'SID DID_HI DID_LO [...]'], 0x23: ['ReadMemoryByAddress', 'SID ALFID ADDR SIZE'],
  0x24: ['ReadScalingDataByIdentifier', 'SID DID'], 0x27: ['SecurityAccess', 'SID LEVEL [KEY]'], 0x28: ['CommunicationControl', 'SID SUBFN COMTYPE'],
  0x29: ['Authentication', 'SID SUBFN ...'], 0x2A: ['ReadDataByPeriodicIdentifier', 'SID MODE PDID...'], 0x2C: ['DynamicallyDefineDataIdentifier', 'SID SUBFN ...'],
  0x2E: ['WriteDataByIdentifier', 'SID DID_HI DID_LO DATA...'], 0x2F: ['InputOutputControlByIdentifier', 'SID DID_HI DID_LO CTRL [STATE]'],
  0x31: ['RoutineControl', 'SID SUBFN RID_HI RID_LO [PARAMS]'], 0x34: ['RequestDownload', 'SID DFI ALFID ADDR SIZE'], 0x35: ['RequestUpload', 'SID DFI ALFID ADDR SIZE'],
  0x36: ['TransferData', 'SID BSC DATA...'], 0x37: ['RequestTransferExit', 'SID'], 0x38: ['RequestFileTransfer', 'SID MODE ...'],
  0x3D: ['WriteMemoryByAddress', 'SID ALFID ADDR SIZE DATA'], 0x3E: ['TesterPresent', 'SID SUBFN'], 0x83: ['AccessTimingParameter', 'SID SUBFN'],
  0x84: ['SecuredDataTransmission', 'SID ...'], 0x85: ['ControlDTCSetting', 'SID SUBFN'], 0x86: ['ResponseOnEvent', 'SID ...'], 0x87: ['LinkControl', 'SID SUBFN ...'],
};

export const KWP_SERVICES = {
  0x10: ['StartDiagnosticSession', 'SID MODE'], 0x11: ['ECUReset', 'SID MODE'], 0x12: ['ReadFreezeFrameData', 'SID ...'], 0x13: ['ReadDiagnosticTroubleCodes', 'SID'],
  0x14: ['ClearDiagnosticInformation', 'SID GROUP(2)'], 0x17: ['ReadStatusOfDiagnosticTroubleCodes', 'SID DTC'], 0x18: ['ReadDiagnosticTroubleCodesByStatus', 'SID STATUS GROUP(2)'],
  0x1A: ['ReadECUIdentification', 'SID OPTION'], 0x20: ['StopDiagnosticSession', 'SID'], 0x21: ['ReadDataByLocalIdentifier', 'SID LID'],
  0x22: ['ReadDataByCommonIdentifier', 'SID CID_HI CID_LO'], 0x23: ['ReadMemoryByAddress', 'SID ADDR(3) SIZE'], 0x27: ['SecurityAccess', 'SID LEVEL [KEY]'],
  0x2E: ['WriteDataByCommonIdentifier', 'SID CID DATA'], 0x30: ['InputOutputControlByLocalIdentifier', 'SID LID CTRL ...'], 0x31: ['StartRoutineByLocalIdentifier', 'SID RLID [PARAMS]'],
  0x32: ['StopRoutineByLocalIdentifier', 'SID RLID'], 0x33: ['RequestRoutineResultsByLocalIdentifier', 'SID RLID'], 0x34: ['RequestDownload', 'SID ...'],
  0x36: ['TransferData', 'SID DATA'], 0x37: ['RequestTransferExit', 'SID'], 0x3B: ['WriteDataByLocalIdentifier', 'SID LID DATA'], 0x3D: ['WriteMemoryByAddress', 'SID ADDR SIZE DATA'],
  0x3E: ['TesterPresent', 'SID [RESP]'], 0x81: ['StartCommunication', 'SID'], 0x82: ['StopCommunication', 'SID'], 0x83: ['AccessTimingParameters', 'SID ...'],
};

export const OBD_SERVICES = {
  0x01: ['ShowCurrentData', 'SID PID'], 0x02: ['ShowFreezeFrameData', 'SID PID FRAME'], 0x03: ['ShowStoredDTCs', 'SID'], 0x04: ['ClearDTCs', 'SID'],
  0x05: ['O2SensorMonitoring', 'SID ...'], 0x06: ['OnBoardMonitoring', 'SID MID'], 0x07: ['ShowPendingDTCs', 'SID'], 0x08: ['ControlOnBoardSystem', 'SID TID'],
  0x09: ['RequestVehicleInformation', 'SID INFOTYPE'], 0x0A: ['PermanentDTCs', 'SID'],
};

export const NRC = {
  0x10: 'generalReject', 0x11: 'serviceNotSupported', 0x12: 'subFunctionNotSupported', 0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong', 0x21: 'busyRepeatRequest', 0x22: 'conditionsNotCorrect', 0x24: 'requestSequenceError',
  0x25: 'noResponseFromSubnetComponent', 0x26: 'failurePreventsExecutionOfRequestedAction', 0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied', 0x35: 'invalidKey', 0x36: 'exceedNumberOfAttempts', 0x37: 'requiredTimeDelayNotExpired',
  0x70: 'uploadDownloadNotAccepted', 0x71: 'transferDataSuspended', 0x72: 'generalProgrammingFailure', 0x73: 'wrongBlockSequenceCounter',
  0x78: 'requestCorrectlyReceived-ResponsePending', 0x7E: 'subFunctionNotSupportedInActiveSession', 0x7F: 'serviceNotSupportedInActiveSession',
  0x81: 'rpmTooHigh', 0x82: 'rpmTooLow', 0x83: 'engineIsRunning', 0x84: 'engineIsNotRunning', 0x85: 'engineRunTimeTooLow',
  0x86: 'temperatureTooHigh', 0x87: 'temperatureTooLow', 0x88: 'vehicleSpeedTooHigh', 0x89: 'vehicleSpeedTooLow',
  0x8A: 'throttlePedalTooHigh', 0x8B: 'throttlePedalTooLow', 0x8C: 'transmissionRangeNotInNeutral', 0x8D: 'transmissionRangeNotInGear',
  0x8F: 'brakeSwitchesNotClosed', 0x90: 'shifterLeverNotInPark', 0x91: 'torqueConverterClutchLocked', 0x92: 'voltageTooHigh', 0x93: 'voltageTooLow',
};

export const UDS_SESSIONS = { 0x01: 'defaultSession', 0x02: 'programmingSession', 0x03: 'extendedDiagnosticSession', 0x04: 'safetySystemDiagnosticSession' };

export const COMMON_DIDS = {
  0xF180: 'bootSoftwareIdentification', 0xF181: 'applicationSoftwareIdentification', 0xF186: 'activeDiagnosticSession',
  0xF187: 'vehicleManufacturerSparePartNumber', 0xF18A: 'systemSupplierIdentifier', 0xF18B: 'ECUManufacturingDate', 0xF18C: 'ECUSerialNumber',
  0xF190: 'VIN', 0xF191: 'vehicleManufacturerECUHardwareNumber', 0xF192: 'systemSupplierECUHardwareNumber', 0xF193: 'systemSupplierECUHardwareVersionNumber',
  0xF194: 'systemSupplierECUSoftwareNumber', 0xF195: 'systemSupplierECUSoftwareVersionNumber', 0xF197: 'systemNameOrEngineType',
  0xF198: 'repairShopCodeOrTesterSerialNumber', 0xF199: 'programmingDate', 0xF19E: 'ODXFileIdentifier', 0xF1A0: 'PSA: ECU identification (zone)',
};

/**
 * Describe a raw diagnostic request/response (bytes after ISO-TP reassembly).
 * protocol: 'UDS' | 'KWP2000' | 'EOBD'; protocols: optional Map of repository protocol definitions.
 */
export function describeMessage(bytes, protocol = 'UDS', repoProtocols = null) {
  if (!bytes || !bytes.length) return { text: '' };
  const sid = bytes[0];
  const table = protocol === 'KWP2000' || protocol === 'KWP-PSA2000' ? KWP_SERVICES : protocol === 'EOBD' ? OBD_SERVICES : UDS_SERVICES;
  const repo = repoProtocols && [...repoProtocols.values()].find((p) => p.protocol === protocol || p.name === protocol);
  const lookup = (s) => {
    if (repo) { const r = repo.services.find((x) => x.sid === s); if (r) return { name: r.name, layout: r.request, subfunctions: r.subfunctions, fromRepo: true }; }
    const t = table[s];
    return t ? { name: t[0], layout: t[1] } : null;
  };
  if (sid === 0x7F) {
    const svc = lookup(bytes[1]);
    const nrcName = (repo && repo.nrcs.find((x) => x.raw === bytes[2])) ? repo.nrcs.find((x) => x.raw === bytes[2]).text?.en : NRC[bytes[2]];
    return { kind: 'negative', text: `Negative response to ${svc ? svc.name : '0x' + (bytes[1] ?? 0).toString(16)}: NRC 0x${(bytes[2] ?? 0).toString(16).toUpperCase().padStart(2, '0')} ${nrcName || 'unknown'}` };
  }
  if (sid >= 0x40 && sid < 0x80 || sid >= 0xC0) {
    const svc = lookup(sid - 0x40);
    return { kind: 'positive', text: `Positive response to ${svc ? svc.name : '0x' + (sid - 0x40).toString(16)}` };
  }
  const svc = lookup(sid);
  if (!svc) return { kind: 'request', text: `Unknown service 0x${sid.toString(16).toUpperCase()}` };
  let extra = '';
  if ((sid === 0x22 || sid === 0x2E || sid === 0x2F) && protocol === 'UDS' && bytes.length >= 3) {
    const did = (bytes[1] << 8) | bytes[2];
    extra = ` DID 0x${did.toString(16).toUpperCase().padStart(4, '0')}${COMMON_DIDS[did] ? ' (' + COMMON_DIDS[did] + ')' : ''}`;
  } else if (sid === 0x10 && bytes.length >= 2) extra = ` ${UDS_SESSIONS[bytes[1] & 0x7F] || '0x' + bytes[1].toString(16)}`;
  else if (sid === 0x27 && bytes.length >= 2) extra = bytes[1] % 2 ? ` requestSeed (level 0x${bytes[1].toString(16)})` : ` sendKey (level 0x${(bytes[1] - 1).toString(16)})`;
  else if (sid === 0x21 && bytes.length >= 2) extra = ` LID 0x${bytes[1].toString(16).toUpperCase().padStart(2, '0')}`;
  return { kind: 'request', text: `${svc.name}${extra}`, layout: svc.layout, expectedResponse: sid + 0x40 };
}
