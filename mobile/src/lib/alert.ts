import { Alert as NativeAlert } from 'react-native';

/** Import alerts here so Metro selects the browser implementation on web. */
export const Alert = { alert: NativeAlert.alert };
