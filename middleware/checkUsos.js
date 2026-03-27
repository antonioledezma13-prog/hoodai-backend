// Middleware que verifica si el usuario tiene usos disponibles
module.exports = async function checkUsos(req, res, next) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'No autenticado' });

    if (!user.tieneUsos()) {
      return res.status(403).json({
        error: 'sin_usos',
        message: 'Has agotado tus usos disponibles. Suscríbete o compra usos adicionales.',
        usosRestantes: 0,
        plan: user.plan,
      });
    }

    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
