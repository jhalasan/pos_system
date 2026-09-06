import PocketBase from 'pocketbase';
import dotenv from 'dotenv';

dotenv.config();

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://192.168.0.114:8090');

try {
  await pb.collection('_superusers').authWithPassword(process.env.POCKETBASE_SUPERUSER_EMAIL, process.env.POCKETBASE_SUPERUSER_PASSWORD);
  console.log('SUPERUSER_AUTH_OK');
  const users = await pb.collection('users').getFullList({ requestKey: null, fields: 'id,email,name,role,status,void_barcode,created' });
  console.log(JSON.stringify(users, null, 2));
} catch (error) {
  console.error('ERROR', error?.message || error);
  console.error(JSON.stringify(error?.response?.data || error?.data || error, null, 2));
}
