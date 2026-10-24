// MongoDB connection and all data models.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

export async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { autoIndex: true });
}

export const db = () => mongoose.connection.db;

// Startup: customers from before customer groups go to the "default" group,
// and the old one-email-for-everyone indexes are removed.
export async function migrateUsers() {
  const users = mongoose.connection.db.collection('users');
  const { modifiedCount } = await users.updateMany({ group: { $exists: false } }, { $set: { group: 'default' } });
  if (modifiedCount) console.log(`[db] ${modifiedCount} existing customers put in customer group "default"`);
  const old = ['email_1', 'phone_1', 'identities.provider_1_identities.providerUserId_1'];
  const existing = await users.indexes().catch(() => []);
  for (const ix of existing) {
    if (old.includes(ix.name)) {
      await users.dropIndex(ix.name);
      console.log(`[db] removed old index ${ix.name}`);
    }
  }
  await User.createIndexes();
}

// ---------- Customers (shared by all stores) ----------

const IdentitySchema = new Schema({
  provider: { type: String, enum: ['google', 'facebook', 'apple'], required: true },
  providerUserId: { type: String, required: true },
  email: String,
  linkedAt: { type: Date, default: Date.now },
}, { _id: false });

const UserSchema = new Schema({
  // Customer group: stores in the same group share customers; other groups
  // never see them. See Store.customerGroup.
  group: { type: String, default: 'default' },
  email: { type: String, lowercase: true, trim: true },
  emailVerified: { type: Boolean, default: false },
  phone: { type: String, trim: true }, // E.164, e.g. +919876543210
  phoneVerified: { type: Boolean, default: false },
  passwordHash: { type: String, select: false },
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  identities: { type: [IdentitySchema], default: [] },
  tags: { type: [String], default: [] },
  stores: { type: [String], default: [] }, // store ids this customer has logged in to
  status: { type: String, enum: ['active', 'blocked'], default: 'active' },
  lastLoginAt: Date,
  lastLoginMethod: String,
}, { timestamps: true });

// One email / phone / social account per customer group.
UserSchema.index({ group: 1, email: 1 }, { name: 'group_email', unique: true, partialFilterExpression: { email: { $type: 'string' } } });
UserSchema.index({ group: 1, phone: 1 }, { name: 'group_phone', unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
UserSchema.index(
  { group: 1, 'identities.provider': 1, 'identities.providerUserId': 1 },
  { name: 'group_identity', unique: true, partialFilterExpression: { 'identities.providerUserId': { $exists: true } } },
);

UserSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};
UserSchema.methods.checkPassword = async function checkPassword(plain) {
  return this.passwordHash ? bcrypt.compare(plain, this.passwordHash) : false;
};
// Shopify needs a verified email on every login.
UserSchema.methods.canSignIntoShopify = function canSignIntoShopify() {
  return this.status === 'active' && Boolean(this.email) && this.emailVerified;
};
// What Shopify receives in the ID token.
UserSchema.methods.oidcClaims = function oidcClaims() {
  const c = {
    sub: this.id,
    email: this.email,
    email_verified: this.emailVerified,
    given_name: this.firstName || undefined,
    family_name: this.lastName || undefined,
    name: [this.firstName, this.lastName].filter(Boolean).join(' ') || undefined,
    phone_number: this.phone && this.phoneVerified ? this.phone : undefined,
    phone_number_verified: this.phone ? this.phoneVerified : undefined,
    'urn:shopify:customer:tags': this.tags.length ? this.tags : undefined,
  };
  Object.keys(c).forEach((k) => c[k] === undefined && delete c[k]);
  return c;
};

// ---------- One-time codes (stored hashed, auto-deleted when expired) ----------

const OtpSchema = new Schema({
  flowId: { type: String, required: true, index: true },
  purpose: { type: String, enum: ['login_email', 'login_phone', 'verify_email', 'reset_password'], required: true },
  channel: { type: String, enum: ['email', 'sms'], required: true },
  target: { type: String, required: true },
  userId: { type: ObjectId, ref: 'User' },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  consumedAt: Date,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
OtpSchema.index({ target: 1, createdAt: -1 });

// ---------- One login attempt (drawer or hosted page) ----------

const LoginFlowSchema = new Schema({
  _id: { type: String, required: true },
  storeId: { type: String, required: true },
  returnTo: { type: String, required: true },
  otpId: ObjectId,
  userId: { type: ObjectId, ref: 'User' },
  method: String,
  newCustomer: { type: Boolean, default: false },
  resetUserId: { type: ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
LoginFlowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// One-time ticket at the end of a login, exchanged once at /login/complete.
const LoginTicketSchema = new Schema({
  _id: { type: String, required: true },
  userId: { type: ObjectId, ref: 'User', required: true },
  storeId: String,
  method: String,
  returnTo: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
LoginTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const User = model('User', UserSchema);
export const Otp = model('Otp', OtpSchema);
export const LoginFlow = model('LoginFlow', LoginFlowSchema);
export const LoginTicket = model('LoginTicket', LoginTicketSchema);

// ---------- Admin panel data ----------

// One document per store (what used to be stores/<id>.json).
const StoreSchema = new Schema({
  _id: { type: String, required: true }, // store id, e.g. "berrylush06"
  name: String,
  shopDomain: String,
  shopId: String,
  domains: { type: [String], default: [] },
  accountDomain: String,
  extraRedirectUris: { type: [String], default: [] },
  extraLogoutUris: { type: [String], default: [] },
  afterLogin: { type: String, default: 'current' },
  brand: {
    welcome: String, name: String, logoUrl: String, tagline: String, color: String, supportEmail: String,
  },
  smsTemplate: String,
  customerGroup: String,
}, { timestamps: true, minimize: false });

// Key/value settings. Secret values are stored encrypted (see settings.js).
const SettingSchema = new Schema({
  _id: { type: String, required: true },
  value: Schema.Types.Mixed,
}, { timestamps: true });

const AdminSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  lastLoginAt: Date,
}, { timestamps: true });
AdminSchema.methods.setPassword = async function setPassword(plain) { this.passwordHash = await bcrypt.hash(plain, 12); };
AdminSchema.methods.checkPassword = function checkPassword(plain) { return bcrypt.compare(String(plain || ''), this.passwordHash); };

const AdminSessionSchema = new Schema({
  _id: { type: String, required: true },
  adminId: { type: ObjectId, ref: 'Admin', required: true },
  csrf: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
AdminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Store = model('Store', StoreSchema);
export const Setting = model('Setting', SettingSchema);
export const Admin = model('Admin', AdminSchema);
export const AdminSession = model('AdminSession', AdminSessionSchema);
