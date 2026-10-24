// Rescue access to the admin panel: creates the admin, or sets a new password.
//   npm run admin:reset -- you@email.com NewPassword123
import mongoose from 'mongoose';
import { connectDb, Admin, AdminSession } from '../src/db.js';
import { normalizeEmail, passwordProblem } from '../src/users.js';

const email = normalizeEmail(process.argv[2]);
const password = process.argv[3];
if (!email || !password) {
  console.error('Usage: npm run admin:reset -- <email> <new password>');
  process.exit(1);
}
const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}
try {
  await connectDb();
  let admin = await Admin.findOne({ email });
  const created = !admin;
  if (!admin) admin = new Admin({ email });
  await admin.setPassword(password);
  await admin.save();
  await AdminSession.deleteMany({ adminId: admin._id });
  console.log(created ? `Admin ${email} created.` : `Password changed for ${email}. Old sessions signed out.`);
} catch (e) {
  console.error('Error:', e.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
