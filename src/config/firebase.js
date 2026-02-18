import admin from "firebase-admin";
import serviceAccount from "../../library-saas-f2c71-firebase-adminsdk-fbsvc-58ad6778fd.json";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

export default admin;
