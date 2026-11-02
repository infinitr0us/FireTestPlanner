import { language, t } from './i18n';

/** Only call for controlled display enums, never names or recorded FDS quantities. */
export function domainLabel(value: string): string {
  if (language() === 'en') return value;
  switch (value) {
    case 'camera': return t('Camera');
    case 'burner': return t('Burner');
    case 'hood': return t('Hood');
    case 'wall': return t('Wall');
    case 'ceiling': return t('Ceiling');
    case 'obstruction': return t('Obstruction');
    case 'thermocouple': return t('Thermocouple');
    case 'heatFluxSensor': case 'heat flux': case 'heat flux gauge': return t('Heat flux gauge');
    case 'plate-thermometer': return t('Plate thermometer');
    case 'thin-skin': return t('Thin skin');
    case 'thermopile': return t('Thermopile');
    case 'gardon': return t('Gardon (foil)');
    case 'velocityProbe': case 'velocity probe': return t('Velocity probe');
    case 'gasSampling': case 'gas sample': return t('Gas sample');
    case 'loadCell': case 'load cell': return t('Load cell');
    case 'reconstructedFlame': case 'reconstructed flame': return t('Reconstructed flame');
    case 'circle': return t('Circle');
    case 'square': return t('Square');
    case 'rectangle': return t('Rectangle');
    case 'other': return t('Other');
    case 'nominal': return t('Nominal');
    case 'datasheet': return t('Datasheet');
    case 'calibrated': return t('Calibrated');
    case 'measured': return t('Measured');
    case 'simulated': return t('Simulated');
    case 'yes': return t('Yes');
    case 'no': return t('No');
    case 'hidden': return t('Hidden');
    case 'locked': return t('Locked');
    case 'error': return t('Error');
    case 'warning': return t('Warning');
    case 'info': return t('Information');
    case 'north': return t('North');
    case 'north-east': return t('North-east');
    case 'east': return t('East');
    case 'south-east': return t('South-east');
    case 'south': return t('South');
    case 'south-west': return t('South-west');
    case 'west': return t('West');
    case 'north-west': return t('North-west');
    case 'low': return t('below');
    case 'high': return t('above');
    case 'flame': return t('flame');
    default: return value;
  }
}
